const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일 제공 (index.html 등)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 방 데이터 관리 객체
const rooms = {};

// 4자리 무작위 방 코드 생성
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return rooms[code] ? generateRoomCode() : code;
}

// 주사위 초기 상태
function createInitialDice() {
    return Array(5).fill(null).map(() => ({ value: 1, held: false }));
}

io.on('connection', (socket) => {

    // 1. 방 만들기
    socket.on('createRoom', ({ name }) => {
        const roomCode = generateRoomCode();
        socket.roomCode = roomCode;
        socket.join(roomCode);

        rooms[roomCode] = {
            code: roomCode,
            players: [{
                id: socket.id,
                name,
                isHost: true,
                scoreBoard: {}
            }],
            currentTurnIdx: 0,
            currentRound: 1,
            cardSelections: {},
            cardValues: [],
            gameState: {
                rollCount: 0,
                dice: createInitialDice()
            }
        };

        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    // 2. 방 들어가기
    socket.on('joinRoom', ({ roomCode, name }) => {
        const code = roomCode.toUpperCase();
        const room = rooms[code];

        if (!room) {
            return socket.emit('joinError', '존재하지 않는 방 코드입니다.');
        }
        if (room.players.length >= 6) {
            return socket.emit('joinError', '방이 이미 가득 찼습니다. (최대 6명)');
        }

        socket.roomCode = code;
        socket.join(code);

        room.players.push({
            id: socket.id,
            name,
            isHost: false,
            scoreBoard: {}
        });

        socket.emit('roomJoined', { roomCode: code, players: room.players });
        io.to(code).emit('roomUpdated', { players: room.players });
    });

    // 3. 순서 정하기 카드 뽑기 시작
    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const count = room.players.length;
        room.cardSelections = {};
        
        // 1부터 N까지 순위 무작위 섞기
        const ranks = Array.from({ length: count }, (_, i) => i + 1);
        for (let i = ranks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
        }
        room.cardValues = ranks;

        io.to(socket.roomCode).emit('startCardSelection', { playerCount: count });
    });

    // 4. 카드 선택
    socket.on('selectCard', ({ cardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.cardSelections[socket.id] !== undefined) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        room.cardSelections[socket.id] = cardIndex;
        io.to(socket.roomCode).emit('cardSelected', { cardIndex, playerName: player.name });

        // 모든 플레이어가 카드를 뽑은 경우 순서 정렬 후 게임 시작
        if (Object.keys(room.cardSelections).length === room.players.length) {
            const playerRanks = room.players.map(p => {
                const selIdx = room.cardSelections[p.id];
                return { player: p, rank: room.cardValues[selIdx] };
            });

            // 순위에 따라 플레이어 순서 재정렬 (1순위가 선턴)
            playerRanks.sort((a, b) => a.rank - b.rank);
            room.players = playerRanks.map(pr => pr.player);
            room.currentTurnIdx = 0;

            io.to(socket.roomCode).emit('revealCards', {
                players: room.players,
                cardValues: room.cardValues,
                selections: room.cardSelections
            });
        }
    });

    // 5. 컵 흔들기 효과 브로드캐스트
    socket.on('shakeCup', () => {
        if (!socket.roomCode) return;
        socket.to(socket.roomCode).emit('shakingCup');
    });

    // 6. 주사위 굴리기
    socket.on('rollDice', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const activePlayer = room.players[room.currentTurnIdx];
        if (activePlayer.id !== socket.id || room.gameState.rollCount >= 3) return;

        // 홀드되지 않은 주사위만 무작위 굴리기
        room.gameState.dice = room.gameState.dice.map(d => {
            if (d.held) return d;
            return { value: Math.floor(Math.random() * 6) + 1, held: false };
        });

        room.gameState.rollCount += 1;

        io.to(socket.roomCode).emit('diceRolled', {
            dice: room.gameState.dice,
            rollCount: room.gameState.rollCount
        });
    });

    // 7. 주사위 홀드 토글
    socket.on('toggleDie', ({ index }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const activePlayer = room.players[room.currentTurnIdx];
        if (activePlayer.id !== socket.id || room.gameState.rollCount === 0) return;

        if (room.gameState.dice[index]) {
            room.gameState.dice[index].held = !room.gameState.dice[index].held;
        }

        io.to(socket.roomCode).emit('dieToggled', { dice: room.gameState.dice });
    });

    // 8. 리롤 중지
    socket.on('stopReRoll', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        room.gameState.rollCount = 3;
        io.to(socket.roomCode).emit('reRollStopped', { dice: room.gameState.dice });
    });

    // 9. 점수 기입 및 턴 넘기기
    socket.on('recordScore', ({ category, score }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const activePlayer = room.players[room.currentTurnIdx];
        if (activePlayer.id !== socket.id) return;

        activePlayer.scoreBoard[category] = score;

        io.to(socket.roomCode).emit('scoreRecorded', {
            playerId: socket.id,
            category,
            score,
            scoreBoard: activePlayer.scoreBoard
        });

        // 턴 및 라운드 변경 처리
        room.currentTurnIdx += 1;

        if (room.currentTurnIdx >= room.players.length) {
            room.currentTurnIdx = 0;
            room.currentRound += 1;
        }

        // 초기화 후 다음 턴 상태 세팅
        room.gameState.rollCount = 0;
        room.gameState.dice = createInitialDice();

        // 12라운드가 모두 끝나면 게임 종료
        if (room.currentRound > 12) {
            io.to(socket.roomCode).emit('gameFinished', { players: room.players });
        } else {
            io.to(socket.roomCode).emit('nextTurn', {
                currentTurnIdx: room.currentTurnIdx,
                round: room.currentRound,
                gameState: room.gameState
            });
        }
    });

    // 10. 게임 재시작 (방 및 인원 전원 유지)
    socket.on('restartGame', () => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        // 점수판 초기화
        room.players.forEach(p => {
            p.scoreBoard = {};
        });

        room.currentRound = 1;
        room.currentTurnIdx = 0;
        room.gameState = {
            rollCount: 0,
            dice: createInitialDice()
        };

        // 방 전체 플레이어에게 동시 재시작 명령 전파
        io.to(roomCode).emit('gameRestarted', {
            players: room.players,
            currentTurnIdx: room.currentTurnIdx,
            gameState: room.gameState
        });
    });

    // 11. 이모지 & 채팅
    socket.on('sendEmoji', ({ emoji }) => {
        if (!socket.roomCode) return;
        io.to(socket.roomCode).emit('emojiReceived', { playerId: socket.id, emoji });
    });

    socket.on('sendMessage', ({ text }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        const sender = player ? player.name : '알수없음';

        io.to(socket.roomCode).emit('messageReceived', {
            sender,
            text,
            isSystem: false
        });
    });

    // 12. 퇴장 및 연결 끊김 처리
    socket.on('leaveGame', () => handleDisconnect(socket));
    socket.on('disconnect', () => handleDisconnect(socket));
});

function handleDisconnect(socket) {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
        delete rooms[roomCode];
    } else {
        // 방장이 나가면 다음 사람에게 방장 승계
        if (!room.players.some(p => p.isHost)) {
            room.players[0].isHost = true;
        }

        io.to(roomCode).emit('roomUpdated', { players: room.players });
        io.to(roomCode).emit('messageReceived', {
            sender: '시스템',
            text: '플레이어가 퇴장하였습니다.',
            isSystem: true
        });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Yacht Dice Server running on port ${PORT}`);
});
