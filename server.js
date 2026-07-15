const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 최상위 폴더(__dirname) 자체를 정적 파일 폴더로 지정
app.use(express.static(__dirname));

// 누군가 접속했을 때 최상위에 있는 index.html을 바로 보내줍니다.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {}; 

// 유저가 직접 채우는 순수 족보 12칸 정의 (종료 판정용)
const pureCategories = [
    'aces','duals','triples','quads','pentas','hexas',
    'choice','poker','full_house','s_straight','l_straight','yacht'
];

// 랜덤 프로필 이모티콘 목록
const profileEmojis = ['🐱', '🐶', '🦊', '🦁', '🐯', '🐼', '🐻', '🐨', '🐰', '🐹', '🐸', '🐵', '🐣', '🦖', '🦄', '🐝'];

function getRandomEmoji() {
    return profileEmojis[Math.floor(Math.random() * profileEmojis.length)];
}

function calculateScore(category, vals) {
    if (!vals || vals.every(v => v === 0)) return 0;
    const counts = {};
    vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const sumAll = vals.reduce((a, b) => a + b, 0);

    switch (category) {
        case 'aces': return (counts[1] || 0) * 1;
        case 'duals': return (counts[2] || 0) * 2;
        case 'triples': return (counts[3] || 0) * 3;
        case 'quads': return (counts[4] || 0) * 4;
        case 'pentas': return (counts[5] || 0) * 5;
        case 'hexas': return (counts[6] || 0) * 6;
        case 'choice': return sumAll;
        case 'poker': {
            for (let val in counts) {
                if (counts[val] >= 4) return sumAll;
            }
            return 0;
        }
        case 'full_house': {
            let hasThree = false;
            let hasTwo = false;
            for (let val in counts) {
                if (counts[val] === 3) hasThree = true;
                if (counts[val] === 2) hasTwo = true;
                if (counts[val] === 5) { hasThree = true; hasTwo = true; }
            }
            return (hasThree && hasTwo) ? sumAll : 0;
        }
        case 's_straight': {
            const uniqueStr = Array.from(new Set(vals)).sort().join('');
            if (uniqueStr.includes('1234') || uniqueStr.includes('2345') || uniqueStr.includes('3456')) return 15;
            return 0;
        }
        case 'l_straight': {
            const uniqueStr = Array.from(new Set(vals)).sort().join('');
            if (uniqueStr === '12345' || uniqueStr === '23456') return 30;
            return 0;
        }
        case 'yacht': {
            for (let val in counts) {
                if (counts[val] === 5) return 50;
            }
            return 0;
        }
        default: return 0;
    }
}

function nextTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayers = room.players.filter(p => p.active);
    if (activePlayers.length === 0) {
        delete rooms[roomCode];
        return;
    }

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    const nextUser = room.players[room.currentTurnIndex];

    // 탈주한 플레이어인 경우 자동으로 0점 패스 처리하여 남은 플레이어들의 게임 보장
    if (!nextUser.active) {
        const unrecordedCategory = pureCategories.find(cat => nextUser.scores[cat] === undefined);
        
        if (unrecordedCategory) {
            nextUser.scores[unrecordedCategory] = 0; // 패스 처리
        }

        // 탈주자 자동 패스 시에도 순수 족보 12칸 기준으로 종료를 계산해야 함
        const isFinished = room.players.every(p => {
            if (!p.active) return true;
            return pureCategories.every(cat => p.scores[cat] !== undefined);
        });

        if (isFinished) {
            room.players.forEach(p => {
                if (p.scores['bonus'] === undefined) p.scores['bonus'] = 0;
            });
            room.stage = 'finished';
            io.to(roomCode).emit('gameFinished', room);
        } else {
            setTimeout(() => { nextTurn(roomCode); }, 500);
        }
        return;
    }

    room.diceValues = [0, 0, 0, 0, 0];
    room.isHeld = [false, false, false, false, false];
    room.remainingRolls = 3;
    room.cupShaken = false;

    io.to(roomCode).emit('gameStateUpdate', room);
}

io.on('connection', (socket) => {
    
    // 1. 방 만들기 (고유 방장 ID 트래킹 구현)
    socket.on('createRoom', ({ nickname }) => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        rooms[roomCode] = {
            code: roomCode,
            leaderId: socket.id, // [수정] 방장 식별자를 고정적으로 명시
            players: [{ 
                id: socket.id, 
                name: nickname, 
                emoji: getRandomEmoji(),
                active: true, 
                scores: {}, 
                sequenceRoll: 0 
            }],
            currentTurnIndex: 0,
            diceValues: [0, 0, 0, 0, 0],
            isHeld: [false, false, false, false, false],
            remainingRolls: 3,
            gameStarted: false,
            stage: 'lobby',
            cupShaken: false,
            cards: [] 
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, nickname });
        io.to(roomCode).emit('gameStateUpdate', rooms[roomCode]);
    });

    // 2. 방 참여하기 (동일 닉네임 튕김 유저 재접속 매칭 추가)
    socket.on('joinRoom', ({ roomCode, nickname }) => {
        const formattedCode = roomCode.trim().toUpperCase();
        const room = rooms[formattedCode];
        
        if (!room) return socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
        
        // [수정] 이미 시작된 방이라도 끊겼던 유저가 같은 닉네임으로 오면 세션 이어받기 허용
        if (room.gameStarted) {
            const inactivePlayer = room.players.find(p => p.name === nickname && !p.active);
            if (inactivePlayer) {
                inactivePlayer.id = socket.id;
                inactivePlayer.active = true;
                
                // 만약 방장 세션이 깨져있었다면 방장 권한 복구
                if (room.leaderId === null || room.players.filter(p => p.active).length === 1) {
                    room.leaderId = socket.id;
                }

                socket.join(formattedCode);
                socket.emit('roomJoined', { roomCode: formattedCode, nickname });
                io.to(formattedCode).emit('gameStateUpdate', room);
                return;
            } else {
                return socket.emit('errorMsg', '이미 게임이 진행 중입니다.');
            }
        }
        
        if (room.players.length >= 6) return socket.emit('errorMsg', '방 정원(6명)이 초과되었습니다.');

        let chosenEmoji = getRandomEmoji();
        const usedEmojis = room.players.map(p => p.emoji);
        for (let i = 0; i < 10; i++) {
            if (!usedEmojis.includes(chosenEmoji)) break;
            chosenEmoji = getRandomEmoji();
        }

        room.players.push({ 
            id: socket.id, 
            name: nickname, 
            emoji: chosenEmoji,
            active: true, 
            scores: {}, 
            sequenceRoll: 0 
        });
        
        socket.join(formattedCode);
        socket.emit('roomJoined', { roomCode: formattedCode, nickname });
        io.to(formattedCode).emit('gameStateUpdate', room);
    });

    // 3. 게임 시작
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        // [수정] 배열 0번 인덱스가 아니라 leaderId 일치 여부로 정확하게 방장 검증
        if (room.leaderId !== socket.id) {
            return socket.emit('errorMsg', '방장만 게임을 시작할 수 있습니다.');
        }

        const pCount = room.players.length;

        if (pCount === 1) {
            room.gameStarted = true;
            room.stage = 'play';
            room.currentTurnIndex = 0;
            room.diceValues = [0, 0, 0, 0, 0];
            room.isHeld = [false, false, false, false, false];
            room.remainingRolls = 3;
            
            io.to(roomCode).emit('gameStateUpdate', room);
            io.to(roomCode).emit('gameStarted', room);
        } else {
            room.gameStarted = true;
            room.stage = 'sequence';
            
            const cardArray = [];
            for (let i = 1; i <= pCount; i++) cardArray.push(i);
            for (let i = cardArray.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cardArray[i], cardArray[j]] = [cardArray[j], cardArray[i]];
            }
            
            room.cards = cardArray.map((val, idx) => ({
                idx: idx,
                value: val,
                chosenBy: null
            }));

            io.to(roomCode).emit('gameStateUpdate', room);
            io.to(roomCode).emit('sequenceStageStarted', room);
            io.to(roomCode).emit('gameStarted', room);
        }
    });

    // 4. 순서 카드 고르기 처리
    socket.on('chooseCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.stage !== 'sequence') return;

        const player = room.players.find(p => p.id === socket.id);
        const card = room.cards.find(c => c.idx === cardIndex);

        if (!player || player.sequenceRoll > 0 || !card || card.chosenBy !== null) return;

        card.chosenBy = socket.id;
        player.sequenceRoll = card.value;

        io.to(roomCode).emit('cardChosen', { 
            playerId: socket.id, 
            cardIndex: cardIndex, 
            value: card.value 
        });

        const allChosen = room.players.every(p => p.sequenceRoll > 0);
        if (allChosen) {
            // [주의] 여기서 정렬이 일어나도 leaderId가 따로 있어서 방장 권한 유지됨
            room.players.sort((a, b) => a.sequenceRoll - b.sequenceRoll);
            
            room.stage = 'play';
            room.currentTurnIndex = 0;
            room.diceValues = [0, 0, 0, 0, 0];
            room.isHeld = [false, false, false, false, false];
            room.remainingRolls = 3;

            io.to(roomCode).emit('gameStateUpdate', room);

            setTimeout(() => {
                io.to(roomCode).emit('gameStarted', room);
            }, 2500);
        } else {
            io.to(roomCode).emit('gameStateUpdate', room);
        }
    });

    // 5. 주사위 굴리기
    socket.on('rollDice', ({ roomCode, clientHeld }) => {
        const room = rooms[roomCode];
        if (!room || room.stage !== 'play') return;

        const activePlayer = room.players[room.currentTurnIndex];
        if (activePlayer.id !== socket.id || room.remainingRolls <= 0) return;

        if (Array.isArray(clientHeld) && clientHeld.length === 5) {
            room.isHeld = clientHeld.map(v => !!v);
        }

        for (let i = 0; i < 5; i++) {
            if (!room.isHeld[i]) {
                room.diceValues[i] = Math.floor(Math.random() * 6) + 1;
            }
        }
        room.remainingRolls--;
        room.cupShaken = true;

        io.to(roomCode).emit('diceRolled', {
            diceValues: room.diceValues,
            remainingRolls: room.remainingRolls,
            isHeld: room.isHeld,
            rollerId: socket.id
        });
        
        io.to(roomCode).emit('gameStateUpdate', room);
    });

    // 6. 점수 입력
    socket.on('writeScore', ({ roomCode, category }) => {
        const room = rooms[roomCode];
        if (!room || room.stage !== 'play') return;

        const activePlayer = room.players[room.currentTurnIndex];
        if (activePlayer.id !== socket.id) return;
        if (activePlayer.scores[category] !== undefined) return;
        if (room.diceValues.every(v => v === 0)) return;

        const score = calculateScore(category, room.diceValues);
        activePlayer.scores[category] = score;

        const subCategories = ['aces','duals','triples','quads','pentas','hexas'];
        let subTotal = 0;
        subCategories.forEach(cat => {
            if (activePlayer.scores[cat] !== undefined) {
                subTotal += activePlayer.scores[cat];
            }
        });

        if (subTotal >= 63 && activePlayer.scores['bonus'] === undefined) {
            activePlayer.scores['bonus'] = 35;
        }

        io.to(roomCode).emit('scoreRegistered', {
            playerId: socket.id,
            category,
            score,
            bonusAwarded: activePlayer.scores['bonus'] === 35
        });

        const isFinished = room.players.every(p => {
            if (!p.active) return true;
            return pureCategories.every(cat => p.scores[cat] !== undefined);
        });

        if (isFinished) {
            room.players.forEach(p => {
                if (p.scores['bonus'] === undefined) {
                    p.scores['bonus'] = 0;
                }
            });
            room.stage = 'finished';
            io.to(roomCode).emit('gameFinished', room);
        } else {
            nextTurn(roomCode);
        }
    });

    // 7. 게임 재시작
    socket.on('restartGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        // [수정] 정확한 leaderId 매칭으로 재시작 보안 강화
        if (!room || room.leaderId !== socket.id) return;

        room.players.forEach(p => {
            p.scores = {};
            p.sequenceRoll = 0;
        });
        room.cards = [];
        
        if (room.players.length === 1) {
            room.stage = 'play';
            room.gameStarted = true;
            room.currentTurnIndex = 0;
            io.to(roomCode).emit('gameStarted', room);
        } else {
            room.stage = 'sequence';
            
            const pCount = room.players.length;
            const cardArray = [];
            for (let i = 1; i <= pCount; i++) cardArray.push(i);
            for (let i = cardArray.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cardArray[i], cardArray[j]] = [cardArray[j], cardArray[i]];
            }
            room.cards = cardArray.map((val, idx) => ({
                idx: idx,
                value: val,
                chosenBy: null
            }));

            io.to(roomCode).emit('sequenceStageStarted', room);
        }
        io.to(roomCode).emit('gameStateUpdate', room);
    });

    // 8. 말풍선 감정표현 이모티콘 중계
    socket.on('sendEmojiBubble', ({ roomCode, emoji }) => {
        const room = rooms[roomCode];
        if (!room) return;

        io.to(roomCode).emit('emojiBubbleReceived', {
            playerId: socket.id,
            emoji: emoji
        });
    });

    // 9. 접속 종료 (퇴장 처리 고도화)
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const isLeaderLeaving = room.leaderId === socket.id;

                if (room.stage === 'lobby' || room.stage === 'sequence') {
                    room.players.splice(playerIndex, 1);
                } else {
                    room.players[playerIndex].active = false;
                }

                const actualConnections = room.players.filter(p => p.active);
                if (actualConnections.length === 0) {
                    delete rooms[roomCode];
                    break;
                }

                // [수정] 진짜 방장이 나갔다면 실제로 세션이 살아있는 유저 중 한 명을 찾아 양도
                if (isLeaderLeaving && actualConnections.length > 0) {
                    room.leaderId = actualConnections[0].id;
                    io.to(roomCode).emit('leaderDelegated', { leaderId: room.leaderId });
                }

                if (room.stage === 'sequence') {
                    room.cards = room.cards.filter(c => c.chosenBy !== socket.id);
                    
                    const allRolled = room.players.every(p => p.sequenceRoll > 0);
                    if (allRolled && room.players.length > 0) {
                        room.players.sort((a, b) => a.sequenceRoll - b.sequenceRoll);
                        room.stage = 'play';
                        room.currentTurnIndex = 0;
                        room.diceValues = [0, 0, 0, 0, 0];
                        room.isHeld = [false, false, false, false, false];
                        room.remainingRolls = 3;
                        io.to(roomCode).emit('gameStarted', room);
                    } else {
                        io.to(roomCode).emit('gameStateUpdate', room);
                    }
                } else if (room.stage === 'play' && room.currentTurnIndex === playerIndex) {
                    nextTurn(roomCode);
                } else {
                    io.to(roomCode).emit('gameStateUpdate', room);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
