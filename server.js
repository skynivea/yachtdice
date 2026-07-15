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
    
    // 1. 방 만들기 (이모티콘 프로필 추가)
    socket.on('createRoom', ({ nickname }) => {
        // [수정] 방 코드 6자리 생성 (기존 유지)
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        rooms[roomCode] = {
            code: roomCode,
            // 프로필 이미지 역할을 할 임의의 emoji 추가
            players: [{ 
                id: socket.id, 
                name: nickname, 
                emoji: getRandomEmoji(),
                active: true, 
                scores: {}, 
                sequenceRoll: 0 // 카드 번호를 저장할 변수 (0은 아직 안 뽑음)
            }],
            currentTurnIndex: 0,
            diceValues: [0, 0, 0, 0, 0],
            isHeld: [false, false, false, false, false],
            remainingRolls: 3,
            gameStarted: false,
            stage: 'lobby',
            cupShaken: false,
            // 순서 카드를 위한 상태값 추가
            cards: [] 
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, nickname });
        io.to(roomCode).emit('gameStateUpdate', rooms[roomCode]);
    });

    // 2. 방 참여하기 (정원 1~6인 보장 및 이모티콘 프로필 추가)
    socket.on('joinRoom', ({ roomCode, nickname }) => {
        // 클라이언트 사이드에서 roomCode를 보낼 때 대문자로 변환하여 일치하도록 가이드
        const formattedCode = roomCode.trim().toUpperCase();
        const room = rooms[formattedCode];
        
        if (!room) return socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
        if (room.gameStarted) return socket.emit('errorMsg', '이미 게임이 진행 중입니다.');
        if (room.players.length >= 6) return socket.emit('errorMsg', '방 정원(6명)이 초과되었습니다.');

        // 중복 프로필 최소화를 위해 안 겹치는 이모티콘 우선 선택 시도
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

    // 3. 게임 시작 (순서 카드 세팅)
    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.players[0].id !== socket.id) return;

        const pCount = room.players.length;

        if (pCount === 1) {
            // 1인 게임일 때는 카드 뽑기(순서 정하기) 단계 생략하고 바로 플레이
            room.gameStarted = true;
            room.stage = 'play';
            room.currentTurnIndex = 0;
            io.to(roomCode).emit('gameStarted', room);
        } else {
            // N인 게임일 때는 순서 정하기 단계 진입
            room.gameStarted = true;
            room.stage = 'sequence';
            
            // 1부터 N까지의 숫자를 섞어서 카드 더미 생성
            const cardArray = [];
            for (let i = 1; i <= pCount; i++) {
                cardArray.push(i);
            }
            // 카드 섞기 (Fisher-Yates)
            for (let i = cardArray.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cardArray[i], cardArray[j]] = [cardArray[j], cardArray[i]];
            }
            
            // 각 카드는 { id: 카드 고유 인덱스, value: 순서 숫자, chosenBy: 고른 사람 ID(null) }
            room.cards = cardArray.map((val, idx) => ({
                idx: idx,
                value: val,
                chosenBy: null
            }));

            io.to(roomCode).emit('sequenceStageStarted', room);
        }
    });

    // 4. 순서 카드 고르기 처리 (실시간 썸네일 재배열)
    socket.on('chooseCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.stage !== 'sequence') return;

        const player = room.players.find(p => p.id === socket.id);
        const card = room.cards.find(c => c.idx === cardIndex);

        // 이미 카드를 뽑은 유저거나, 이미 선택된 카드라면 무시
        if (!player || player.sequenceRoll > 0 || !card || card.chosenBy !== null) return;

        // 선택 처리
        card.chosenBy = socket.id;
        player.sequenceRoll = card.value; // 뽑은 숫자(1 ~ N)를 저장

        io.to(roomCode).emit('cardChosen', { 
            playerId: socket.id, 
            cardIndex: cardIndex, 
            value: card.value 
        });

        // 모든 플레이어가 카드를 뽑았는지 확인
        const allChosen = room.players.every(p => p.sequenceRoll > 0);
        if (allChosen) {
            // [수정] 뽑은 카드 숫자(1~N)가 낮은 순서대로 정렬하여 턴 배치 (1등이 선공)
            room.players.sort((a, b) => a.sequenceRoll - b.sequenceRoll);
            
            room.stage = 'play';
            room.currentTurnIndex = 0;
            room.diceValues = [0, 0, 0, 0, 0];
            room.isHeld = [false, false, false, false, false];
            room.remainingRolls = 3;

            // 정렬된 순서를 포함하여 전체 방 상태 업데이트 후 2초 뒤 시작
            io.to(roomCode).emit('gameStateUpdate', room);

            setTimeout(() => {
                io.to(roomCode).emit('gameStarted', room);
            }, 2500);
        } else {
            io.to(roomCode).emit('gameStateUpdate', room);
        }
    });

    // 5. 주사위 굴리기 (동기화)
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

        // 방 전체에 주사위 현황을 전송하여 관전자들도 실시간으로 볼 수 있게 함
        io.to(roomCode).emit('diceRolled', {
            diceValues: room.diceValues,
            remainingRolls: room.remainingRolls,
            isHeld: room.isHeld,
            rollerId: socket.id
        });
        
        // 전체 방 정보 동기화 (관전자들의 전광판 실시간 업데이트용)
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

        // 순수 12칸 기준 종료 판정
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
        if (!room || room.players[0].id !== socket.id) return;

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

    // 8. 접속 종료 (퇴장 처리)
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const wasLeader = playerIndex === 0;

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

                if (wasLeader && room.players.length > 0) {
                    io.to(roomCode).emit('leaderDelegated', { leaderId: room.players[0].id });
                }

                // 순서 뽑기 도중 누군가 이탈했을 때 처리
                if (room.stage === 'sequence') {
                    // 나간 사람을 제외하고 남은 카드 리스트 재배정 필요성 체크
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
