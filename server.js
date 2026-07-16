const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 방 데이터 구조
// rooms[roomCode] = {
//    id: roomCode,
//    players: [{ id, name, isHost, scoreBoard, orderCard, order }],
//    status: 'lobby' | 'card_selection' | 'playing' | 'finished',
//    currentTurnIdx: 0,
//    round: 1, // 총 12라운드
//    gameState: { dice: [], kept: [], rollCount: 0, status: 'shaking' | 'rolled' | 'choosing' },
//    emojis: []
// }
const rooms = {};

// 4자리 랜덤 방 코드 생성
function generateRoomCode() {
    let code = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// 셔플 알고리즘
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

io.on('connection', (socket) => {
    let currentRoom = null;
    let myPlayerId = socket.id;

    // 방 만들기
    socket.on('createRoom', ({ name }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            players: [{ id: socket.id, name, isHost: true, scoreBoard: {}, orderCard: null, order: 0 }],
            status: 'lobby',
            currentTurnIdx: 0,
            round: 1,
            gameState: {
                dice: [1, 2, 3, 4, 5].map(() => ({ value: 1, held: false })), // false: 필드, true: 홈
                rollCount: 0,
                status: 'ready' // ready, shaking, rolled
            }
        };
        currentRoom = roomCode;
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    // 방 들어가기
    socket.on('joinRoom', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('joinError', '방이 존재하지 않습니다.');
        }
        if (room.status !== 'lobby') {
            return socket.emit('joinError', '이미 게임이 시작된 방입니다.');
        }
        if (room.players.length >= 6) {
            return socket.emit('joinError', '방이 가득 찼습니다. (최대 6인)');
        }

        room.players.push({ id: socket.id, name, isHost: false, scoreBoard: {}, orderCard: null, order: 0 });
        currentRoom = roomCode;
        socket.join(roomCode);
        
        io.to(roomCode).emit('roomUpdated', { players: room.players });
    });

    // 게임 시작 (방장 권한)
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room || room.players[0].id !== socket.id) return;

        if (room.players.length === 1) {
            // 혼자 하기면 바로 게임 시작
            room.status = 'playing';
            room.players[0].order = 1;
            initTurn(room);
            io.to(currentRoom).emit('gameStarted', { players: room.players, currentTurnIdx: 0 });
        } else {
            // 멀티플레이면 카드 뽑기로 순서 결정
            room.status = 'card_selection';
            // 카드 목록 섞어 준비 (1부터 인원 수 만큼)
            const cards = [];
            for (let i = 1; i <= room.players.length; i++) {
                cards.push(i);
            }
            room.preparedCards = shuffle(cards);
            room.cardSelections = {}; // playerId: cardIndex
            io.to(currentRoom).emit('startCardSelection', { playerCount: room.players.length });
        }
    });

    // 카드 선택하기
    socket.on('selectCard', ({ cardIndex }) => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'card_selection') return;

        // 이미 선택한 주소인지 확인
        if (Object.values(room.cardSelections).includes(cardIndex)) return;
        if (room.cardSelections[socket.id] !== undefined) return;

        room.cardSelections[socket.id] = cardIndex;
        const playerName = room.players.find(p => p.id === socket.id).name;

        io.to(currentRoom).emit('cardSelected', { cardIndex, playerName, playerId: socket.id });

        // 모든 플레이어가 카드를 선택했는지 확인
        if (Object.keys(room.cardSelections).length === room.players.length) {
            // 순서 결정
            room.players.forEach(p => {
                const selIdx = room.cardSelections[p.id];
                p.order = room.preparedCards[selIdx]; // 정해진 순서 부여
            });

            // 순서 순으로 플레이어 재배열
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

    // 턴 초기 설정 함수
    function initTurn(room) {
        room.gameState = {
            dice: [
                { value: 1, held: false },
                { value: 2, held: false },
                { value: 3, held: false },
                { value: 4, held: false },
                { value: 5, held: false }
            ],
            rollCount: 0,
            status: 'ready' // 통 안에 들어가 있는 기본 상태
        };
    }

    // 주사위 컵 흔들기 시작 (모두에게 동기화)
    socket.on('shakeCup', () => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;
        
        // 현재 차례 플레이어 검증
        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id) return;
        if (room.gameState.rollCount >= 3) return;

        room.gameState.status = 'shaking';
        io.to(currentRoom).emit('shakingCup', { playerId: socket.id });
    });

    // 주사위 던지기 완성
    socket.on('rollDice', () => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id) return;
        if (room.gameState.rollCount >= 3) return;

        // 필드에 있는(held: false) 주사위만 완전히 새로운 무작위 값으로 변경
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

    // 주사위 홀드 토글 (필드 <-> 홈 이동)
    socket.on('toggleDie', ({ index }) => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id) return;
        // 주사위를 최소 한 번은 굴려 필드에 나왔을 때만 홀드 가능
        if (room.gameState.rollCount === 0) return; 

        room.gameState.dice[index].held = !room.gameState.dice[index].held;
        
        io.to(currentRoom).emit('dieToggled', { index, dice: room.gameState.dice });
    });

    // 리롤 그만하고 족보 결정하기 (모든 주사위를 홈으로 흡수 처리)
    socket.on('stopReRoll', () => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id) return;
        if (room.gameState.rollCount === 0) return; // 굴린 적 없으면 불가

        room.gameState.dice.forEach(die => die.held = true); // 전부 홀드 처리
        room.gameState.rollCount = 3; // 리롤 횟수 소진

        io.to(currentRoom).emit('reRollStopped', { dice: room.gameState.dice });
    });

    // 점수 기입 요청
    socket.on('recordScore', ({ category, score }) => {
        const room = rooms[currentRoom];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIdx];
        if (currentPlayer.id !== socket.id) return;

        // 이미 점수가 있는 칸인지 확인
        if (currentPlayer.scoreBoard[category] !== undefined) return;

        currentPlayer.scoreBoard[category] = score;

        // 보너스 및 점수 계산 트리거 알림 전송 (폭죽 등의 대형 이벤트를 위함)
        io.to(currentRoom).emit('scoreRecorded', { 
            playerId: socket.id, 
            category, 
            score,
            scoreBoard: currentPlayer.scoreBoard
        });

        // 다음 턴 준비
        setTimeout(() => {
            room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
            
            // 모든 플레이어가 1라운드를 돌았는지 (턴 한 바퀴 완료 시 라운드 증가)
            if (room.currentTurnIdx === 0) {
                room.round += 1;
            }

            // 게임 완료 체크 (12개의 족보가 모두 찼는지 확인)
            const categoriesCount = 12; // 에이스~헥사 (6) + 초이스~요트 (6)
            const isFinished = room.players.every(p => Object.keys(p.scoreBoard).length === categoriesCount);

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
        }, 1500);
    });

    // 실시간 이모티콘 소통
    socket.on('sendEmoji', ({ emoji }) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('emojiReceived', { playerId: socket.id, emoji });
    });

    // 연결 종료 처리
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            room.players = room.players.filter(p => p.id !== socket.id);
            
            if (room.players.length === 0) {
                delete rooms[currentRoom];
            } else {
                io.to(currentRoom).emit('roomUpdated', { players: room.players });
                // 만약 현재 턴인 사람이 나갔다면 다음 사람으로 이전
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
    console.log(`Server is running on port ${PORT}`);
});
