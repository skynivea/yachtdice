const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 1. 최상위 폴더(__dirname) 자체를 정적 파일 폴더로 지정합니다.
// (이렇게 하면 최상위 폴더에 있는 CSS, JS, 이미지 파일들을 브라우저가 바로 읽을 수 있습니다.)
app.use(express.static(__dirname));

// 2. 누군가 접속했을 때 최상위에 있는 index.html을 바로 보내줍니다.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {}; 

// 유저가 직접 채우는 순수 족보 12칸 정의 (종료 판정용)
const pureCategories = [
    'aces','duals','triples','quads','pentas','hexas',
    'choice','poker','full_house','s_straight','l_straight','yacht'
];

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

        // [지뢰 3 해결] 탈주자 자동 패스 시에도 순수 족보 12칸 기준으로 종료를 계산해야 함
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
    socket.on('createRoom', ({ nickname }) => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: [{ id: socket.id, name: nickname, active: true, scores: {}, sequenceRoll: 0 }],
            currentTurnIndex: 0,
            diceValues: [0, 0, 0, 0, 0],
            isHeld: [false, false, false, false, false],
            remainingRolls: 3,
            gameStarted: false,
            stage: 'lobby',
            cupShaken: false
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, nickname });
        io.to(roomCode).emit('gameStateUpdate', rooms[roomCode]);
    });

    socket.on('joinRoom', ({ roomCode, nickname }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
        if (room.gameStarted) return socket.emit('errorMsg', '이미 게임이 진행 중입니다.');
        if (room.players.length >= 6) return socket.emit('errorMsg', '방 정원이 초과되었습니다.');

        room.players.push({ id: socket.id, name: nickname, active: true, scores: {}, sequenceRoll: 0 });
        socket.join(roomCode);
        socket.emit('roomJoined', { roomCode, nickname });
        io.to(roomCode).emit('gameStateUpdate', room);
    });

    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.players[0].id !== socket.id) return;

        if (room.players.length === 1) {
            room.gameStarted = true;
            room.stage = 'play';
            room.currentTurnIndex = 0;
            io.to(roomCode).emit('gameStarted', room);
        } else {
            room.gameStarted = true;
            room.stage = 'sequence';
            io.to(roomCode).emit('sequenceStageStarted', room);
        }
    });

    socket.on('rollSequence', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.stage !== 'sequence') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player && player.sequenceRoll === 0) {
            player.sequenceRoll = Math.floor(Math.random() * 6) + 1;
            io.to(roomCode).emit('sequenceRolled', { playerId: socket.id, value: player.sequenceRoll });

            const allRolled = room.players.every(p => p.sequenceRoll > 0);
            if (allRolled) {
                room.players.sort((a, b) => b.sequenceRoll - a.sequenceRoll);
                room.stage = 'play';
                room.currentTurnIndex = 0;
                room.diceValues = [0, 0, 0, 0, 0];
                room.isHeld = [false, false, false, false, false];
                room.remainingRolls = 3;

                setTimeout(() => {
                    io.to(roomCode).emit('gameStarted', room);
                }, 2000);
            }
        }
    });

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
            isHeld: room.isHeld
        });
    });

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

    socket.on('restartGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.players[0].id !== socket.id) return;

        room.players.forEach(p => {
            p.scores = {};
            p.sequenceRoll = 0;
        });
        
        if (room.players.length === 1) {
            room.stage = 'play';
            room.gameStarted = true;
            room.currentTurnIndex = 0;
            io.to(roomCode).emit('gameStarted', room);
        } else {
            room.stage = 'sequence';
            io.to(roomCode).emit('sequenceStageStarted', room);
        }
        // [보완] 상태 변화를 방 참가자 모두에게 한 번 더 동기화 시켜줌
        io.to(roomCode).emit('gameStateUpdate', room);
    });

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

                // [지뢰 2 해결] 순서 뽑기 도중 누군가 이탈했을 때 남은 플레이어들의 자동 선공 시작 보장
                if (room.stage === 'sequence') {
                    const allRolled = room.players.every(p => p.sequenceRoll > 0);
                    if (allRolled && room.players.length > 0) {
                        room.players.sort((a, b) => b.sequenceRoll - a.sequenceRoll);
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

// [지뢰 1 해결] 포트를 Render 호스팅 환경에 동적으로 맞춤
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
