const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

// 최댓값 정의 및 0점 희생 우선순위 리스트
const MAX_SCORES = { aces: 5, deuces: 10, threes: 15, fours: 20, fives: 25, hexas: 30, choice: 30, fourOfAKind: 30, fullHouse: 28, smallStraight: 15, largeStraight: 30, yacht: 50 };
const sacrificeOrder = ['yacht', 'fullHouse', 'fourOfAKind', 'choice', 'aces', 'deuces', 'threes', 'fours', 'fives', 'hexas', 'smallStraight', 'largeStraight'];

function generateRoomCode() {
    let code = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 서버용 족보 계산 엔진
function getComputedScore(catId, values) {
    const counts = Array(7).fill(0);
    values.forEach(v => counts[v]++);
    const totalSum = values.reduce((a, b) => a + b, 0);

    switch (catId) {
        case 'aces': return counts[1] * 1;
        case 'deuces': return counts[2] * 2;
        case 'threes': return counts[3] * 3;
        case 'fours': return counts[4] * 4;
        case 'fives': return counts[5] * 5;
        case 'hexas': return counts[6] * 6;
        case 'choice': return totalSum;
        case 'fourOfAKind': return counts.some(c => c >= 4) ? totalSum : 0;
        case 'fullHouse':
            const has3 = counts.includes(3);
            const has2 = counts.includes(2);
            const has5 = counts.includes(5);
            return (has3 && has2) || has5 ? totalSum : 0;
        case 'smallStraight':
            const uStr = [...new Set(values)].sort().join('');
            return /1.*2.*3.*4|2.*3.*4.*5|3.*4.*5.*6/.test(uStr) ? 15 : 0;
        case 'largeStraight':
            const sStr = [...new Set(values)].sort().join('');
            return (sStr === '12345' || sStr === '23456') ? 30 : 0;
        case 'yacht': return counts.includes(5) ? 50 : 0;
        default: return 0;
    }
}

// 1분 잠수 자동 타임아웃 타이머 가동 관리자
function startTurnTimer(room) {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = setTimeout(() => {
        handleTimeout(room);
    }, 60000);
}

function handleTimeout(room) {
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.currentTurnIdx];
    if (!player) return;

    io.to(room.id).emit('messageReceived', { text: `⏱️ [${player.name}] 님이 잠수하여 서버가 주사위를 강제로 굴려 족보를 마감합니다.`, isSystem: true });

    // 1. 남은 리롤 횟수 자동 소진 시뮬레이션
    while (room.gameState.rollCount < 3) {
        room.gameState.dice.forEach((die) => {
            if (!die.held) {
                die.value = Math.floor(Math.random() * 6) + 1;
            }
        });
        room.gameState.rollCount += 1;
    }
    room.gameState.status = 'rolled';

    io.to(room.id).emit('diceRolled', { 
        dice: room.gameState.dice, 
        rollCount: room.gameState.rollCount 
    });

    // 2. 최적의 기입 항목 선출 프로세스 (점수/최댓값 비율 계산 공식 적용)
    const values = room.gameState.dice.map(d => d.value);
    const allCats = Object.keys(MAX_SCORES);
    const availableCats = allCats.filter(catId => player.scoreBoard[catId] === undefined);

    let maxScoreFound = -1;
    let scoresMap = {};
    availableCats.forEach(catId => {
        const score = getComputedScore(catId, values);
        scoresMap[catId] = score;
        if (score > maxScoreFound) maxScoreFound = score;
    });

    let selectedCatId = null;
    let finalScore = 0;

    if (maxScoreFound > 0) {
        let candidates = availableCats.filter(catId => scoresMap[catId] === maxScoreFound);
        candidates.sort((a, b) => {
            const ratioA = scoresMap[a] / MAX_SCORES[a];
            const ratioB = scoresMap[b] / MAX_SCORES[b];
            return ratioB - ratioA; 
        });
        selectedCatId = candidates[0];
        finalScore = maxScoreFound;
    } else {
        for (const catId of sacrificeOrder) {
            if (player.scoreBoard[catId] === undefined) {
                selectedCatId = catId;
                break;
            }
        }
        finalScore = 0;
    }

    // 3. 족보 확정 및 전파
    player.scoreBoard[selectedCatId] = finalScore;
    io.to(room.id).emit('scoreRecorded', { 
        playerId: player.id, 
        category: selectedCatId, 
        score: finalScore,
        scoreBoard: player.scoreBoard
    });

    // 4. 다음 턴 이관
    setTimeout(() => {
        if (!rooms[room.id]) return; 
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
        if (room.currentTurnIdx === 0) room.round += 1;

        const totalCategories = 12;
        const isFinished = room.players.every(p => Object.keys(p.scoreBoard).length === totalCategories);

        if (isFinished || room.round > 12) {
            room.status = 'finished';
            if (room.turnTimer) clearTimeout(room.turnTimer);
            io.to(room.id).emit('gameFinished', { players: room.players });
        } else {
            initTurn(room);
            startTurnTimer(room);
            io.to(room.id).emit('nextTurn', { 
                currentTurnIdx: room.currentTurnIdx, 
                round: room.round,
                gameState: room.gameState
            });
        }
    }, 1200);
}

function handlePlayerLeave(socket, roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const pIdx = room.players.findIndex(p => p.id === socket.id);
    if (pIdx === -1) return;

    const leavingPlayer = room.players[pIdx];
    io.to(roomCode).emit('messageReceived', { text: `🚪 [${leavingPlayer.name}] 님이 게임판을 박차고 나갔습니다. (점수 무효화)`, isSystem: true });

    // 방장 여부 판별
    const wasHost = leavingPlayer.isHost;
    
    // 플레이어 퇴출
    room.players.splice(pIdx, 1);

    if (room.players.length === 0) {
        if (room.turnTimer) clearTimeout(room.turnTimer);
        delete rooms[roomCode];
        return;
    }

    // 방장 위임
    if (wasHost && room.players.length > 0) {
        room.players[0].isHost = true;
    }

    if (room.status === 'playing') {
        // 최후의 1인 엔딩 체크
        if (room.players.length === 1) {
            if (room.turnTimer) clearTimeout(room.turnTimer);
            room.status = 'finished';
            io.to(roomCode).emit('gameFinished', { players: room.players });
            return;
        }

        // 현재 탈주자가 내 턴이었던 경우
        if (room.currentTurnIdx === pIdx) {
            room.currentTurnIdx = room.currentTurnIdx % room.players.length;
            initTurn(room);
            startTurnTimer(room);
            io.to(roomCode).emit('roomUpdated', { players: room.players });
            io.to(roomCode).emit('nextTurn', { 
                currentTurnIdx: room.currentTurnIdx, 
                round: room.round,
                gameState: room.gameState
            });
        } else {
            if (pIdx < room.currentTurnIdx) {
                room.currentTurnIdx--;
            }
            io.to(roomCode).emit('roomUpdated', { players: room.players });
        }
    } else {
        io.to(roomCode).emit('roomUpdated', { players: room.players });
    }
}

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('createRoom', ({ name }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            players: [{ id: socket.id, name, isHost: true, scoreBoard: {}, order: 0 }],
            status: 'lobby',
            currentTurnIdx: 0,
            round: 1,
            gameState: {
                dice: Array(5).fill(null).map(() => ({ value: 1, held: false })),
                rollCount: 0,
                status: 'ready'
            },
            turnTimer: null
        };
        currentRoom = roomCode;
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    socket.on('joinRoom', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('joinError', '방이 존재하지 않습니다.');
        if (room.status !== 'lobby') return socket.emit('joinError', '이미 시작된 방입니다.');
        if (room.players.length >= 6) return socket.emit('joinError', '방이 만원입니다.');

        room.players.push({ id: socket.id, name, isHost: false, scoreBoard: {}, order: 0 });
        currentRoom = roomCode;
        socket.join(roomCode);
        
        socket.emit('roomJoined', { roomCode, players: room.players });
        socket.to(roomCode).emit('roomUpdated', { players: room.players });
    });

    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room || room.players[0].id !== socket.id) return;

        if (room.players.length === 1) {
            room.status = 'playing';
            room.players[0].order = 1;
            initTurn(room);
            startTurnTimer(room);
            io.to(currentRoom).emit('gameStarted', { players: room.players, currentTurnIdx: 0 });
        } else {
            room.status = 'card_selection';
            const cards = [];
            for (let i = 1; i <= room.players.length; i++) cards.push(i);
            room.preparedCards = shuffle(cards);
            room.cardSelections = {}; 
            io.to(currentRoom).emit('startCardSelection', { playerCount: room.players.length });
        }
    });

    socket.on('selectCard', ({ cardIndex }) => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'card_selection') return;
        if (Object.values(room.cardSelections).includes(cardIndex)) return;
        if (room.cardSelections[socket.id] !== undefined) return;

        room.cardSelections[socket.id] = cardIndex;
        const playerName = room.players.find(p => p.id === socket.id).name;
        io.to(currentRoom).emit('cardSelected', { cardIndex, playerName, playerId: socket.id });

        if (Object.keys(room.cardSelections).length === room.players.length) {
            room.players.forEach(p => {
                p.order = room.preparedCards[room.cardSelections[p.id]];
            });
            room.players.sort((a, b) => a.order - b.order);
            room.status = 'playing';
            room.currentTurnIdx = 0;
            room.round = 1;
            initTurn(room);
            startTurnTimer(room);

            setTimeout(() => {
                io.to(currentRoom).emit('revealCards', { 
                    players: room.players, 
                    cardValues: room.preparedCards, 
                    selections: room.cardSelections 
                });
            }, 1000);
        }
    });

    function initTurn(room) {
        room.gameState = {
            dice: Array(5).fill(null).map(() => ({ value: 1, held: false })),
            rollCount: 0,
            status: 'ready'
        };
    }

    socket.on('shakeCup', () => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;
        
        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id || room.gameState.rollCount >= 3) return;

        room.gameState.status = 'shaking';
        io.to(currentRoom).emit('shakingCup', { playerId: socket.id });
    });

    socket.on('rollDice', () => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id || room.gameState.rollCount >= 3) return;

        room.gameState.dice.forEach((die) => {
            if (!die.held) die.value = Math.floor(Math.random() * 6) + 1;
        });

        room.gameState.rollCount += 1;
        room.gameState.status = 'rolled';

        startTurnTimer(room); // 조작 인정 리셋 및 재가동

        io.to(currentRoom).emit('diceRolled', { 
            dice: room.gameState.dice, 
            rollCount: room.gameState.rollCount 
        });
    });

    socket.on('toggleDie', ({ index }) => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id || room.gameState.rollCount === 0) return; 

        room.gameState.dice[index].held = !room.gameState.dice[index].held;
        
        startTurnTimer(room); // 조작 인정 리셋 및 재가동

        io.to(currentRoom).emit('dieToggled', { index, dice: room.gameState.dice });
    });

    socket.on('stopReRoll', () => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id || room.gameState.rollCount === 0) return;

        room.gameState.dice.forEach(die => die.held = true);
        room.gameState.rollCount = 3;

        io.to(currentRoom).emit('reRollStopped', { dice: room.gameState.dice });
    });

    socket.on('recordScore', ({ category, score }) => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id || currentPlayer.scoreBoard[category] !== undefined) return;

        if (room.turnTimer) clearTimeout(room.turnTimer);

        currentPlayer.scoreBoard[category] = score;
        io.to(currentRoom).emit('scoreRecorded', { 
            playerId: socket.id, 
            category, 
            score,
            scoreBoard: currentPlayer.scoreBoard
        });

        setTimeout(() => {
            if (!rooms[currentRoom]) return;
            room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
            if (room.currentTurnIdx === 0) room.round += 1;

            const totalCategories = 12;
            const isFinished = room.players.every(p => Object.keys(p.scoreBoard).length === totalCategories);

            if (isFinished || room.round > 12) {
                room.status = 'finished';
                io.to(currentRoom).emit('gameFinished', { players: room.players });
            } else {
                initTurn(room);
                startTurnTimer(room);
                io.to(currentRoom).emit('nextTurn', { 
                    currentTurnIdx: room.currentTurnIdx, 
                    round: room.round,
                    gameState: room.gameState
                });
            }
        }, 800);
    });

    // 실시간 대화 서버 라우터
    socket.on('sendMessage', ({ text }) => {
        const room = rooms[currentRoom];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        io.to(currentRoom).emit('messageReceived', { 
            sender: player.name, 
            text, 
            isSystem: false 
        });
    });

    // 수동 퇴장 처리
    socket.on('leaveGame', () => {
        handlePlayerLeave(socket, currentRoom);
    });

    socket.on('sendEmoji', ({ emoji }) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('emojiReceived', { playerId: socket.id, emoji });
    });

    socket.on('disconnect', () => {
        if (currentRoom) {
            handlePlayerLeave(socket, currentRoom);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
