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

io.on('connection', (socket) => {
    let currentRoom = null;

    // 방 만들기
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
            }
        };
        currentRoom = roomCode;
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    // 방 들어가기 (버그 1 해결: 신규 가입자 전용 'roomJoined' 및 기존원 전용 'roomUpdated' 분리 방출)
    socket.on('joinRoom', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('joinError', '방이 존재하지 않습니다.');
        if (room.status !== 'lobby') return socket.emit('joinError', '이미 시작된 방입니다. 추가 입장이 불가합니다.');
        if (room.players.length >= 6) return socket.emit('joinError', '방이 만원입니다. (최대 6인 가능)');

        room.players.push({ id: socket.id, name, isHost: false, scoreBoard: {}, order: 0 });
        currentRoom = roomCode;
        socket.join(roomCode);
        
        socket.emit('roomJoined', { roomCode, players: room.players });
        socket.to(roomCode).emit('roomUpdated', { players: room.players });
    });

    // 게임 시작
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room || room.players[0].id !== socket.id) return;

        if (room.players.length === 1) {
            room.status = 'playing';
            room.players[0].order = 1;
            initTurn(room);
            io.to(currentRoom).emit('gameStarted', { players: room.players, currentTurnIdx: 0 });
        } else {
            room.status = 'card_selection';
            const cards = [];
            for (let i = 1; i <= room.players.length; i++) {
                cards.push(i);
            }
            room.preparedCards = shuffle(cards);
            room.cardSelections = {}; 
            io.to(currentRoom).emit('startCardSelection', { playerCount: room.players.length });
        }
    });

    // 카드 순서 뒤집기 선택
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
                const selIdx = room.cardSelections[p.id];
                p.order = room.preparedCards[selIdx];
            });

            room.players.sort((a, b) => a.order - b.order);
            room.status = 'playing';
            room.currentTurnIdx = 0;
            room.round = 1;
            initTurn(room);

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
            dice: [
                { value: 1, held: false },
                { value: 1, held: false },
                { value: 1, held: false },
                { value: 1, held: false },
                { value: 1, held: false }
            ],
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
            if (!die.held) {
                die.value = Math.floor(Math.random() * 6) + 1;
            }
        });

        room.gameState.rollCount += 1;
        room.gameState.status = 'rolled';

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
        if (currentPlayer.id !== socket.id) return;
        if (currentPlayer.scoreBoard[category] !== undefined) return;

        currentPlayer.scoreBoard[category] = score;

        io.to(currentRoom).emit('scoreRecorded', { 
            playerId: socket.id, 
            category, 
            score,
            scoreBoard: currentPlayer.scoreBoard
        });

        setTimeout(() => {
            room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
            
            if (room.currentTurnIdx === 0) {
                room.round += 1;
            }

            const totalCategories = 12;
            const isFinished = room.players.every(p => Object.keys(p.scoreBoard).length === totalCategories);

            if (isFinished || room.round > 12) {
                room.status = 'finished';
                io.to(currentRoom).emit('gameFinished', { players: room.players });
            } else {
                initTurn(room);
                io.to(currentRoom).emit('nextTurn', { 
                    currentTurnIdx: room.currentTurnIdx, 
                    round: room.round,
                    gameState: room.gameState
                });
            }
        }, 800);
    });

    socket.on('sendEmoji', ({ emoji }) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('emojiReceived', { playerId: socket.id, emoji });
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            room.players = room.players.filter(p => p.id !== socket.id);
            
            if (room.players.length === 0) {
                delete rooms[currentRoom];
            } else {
                io.to(currentRoom).emit('roomUpdated', { players: room.players });
                if (room.status === 'playing') {
                    room.currentTurnIdx = room.currentTurnIdx % room.players.length;
                    io.to(currentRoom).emit('nextTurn', { 
                        currentTurnIdx: room.currentTurnIdx, 
                        round: room.round,
                        gameState: room.gameState
                    });
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
