const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

// 신규 방 생성 템플릿
function createRoom(roomId) {
    return {
        id: roomId,
        players: [],
        stage: 'lobby', // 'lobby', 'sequence', 'play', 'end'
        cards: [],
        activePlayerIdx: 0,
        round: 1,
        maxRounds: 12
    };
}

// 신규 플레이어 템플릿
function createPlayer(id, name, isHost) {
    return {
        id,
        name,
        isHost,
        sequenceRoll: null,
        rollsLeft: 3,
        dice: [1, 1, 1, 1, 1],
        kept: [false, false, false, false, false],
        scoreBoard: {
            ones: null,
            twos: null,
            threes: null,
            fours: null,
            fives: null,
            sixes: null,
            choice: null,
            four_of_a_kind: null, // 포커 슬롯
            full_house: null,
            small_straight: null,
            large_straight: null,
            yacht: null
        },
        totalScore: 0,
        bonus: 0
    };
}

// 야추 및 포커 점수 규칙 계산기
function calculateScore(category, dice) {
    const counts = {};
    dice.forEach(d => counts[d] = (counts[d] || 0) + 1);
    const sum = dice.reduce((a, b) => a + b, 0);

    switch (category) {
        case 'ones': return (counts[1] || 0) * 1;
        case 'twos': return (counts[2] || 0) * 2;
        case 'threes': return (counts[3] || 0) * 3;
        case 'fours': return (counts[4] || 0) * 4;
        case 'fives': return (counts[5] || 0) * 5;
        case 'sixes': return (counts[6] || 0) * 6;
        case 'choice': return sum;
        case 'four_of_a_kind': // 포커 계산법 수정 (동일 눈값 * 개수)
            for (let num in counts) {
                if (counts[num] >= 4) {
                    return Number(num) * counts[num];
                }
            }
            return 0;
        case 'full_house':
            let hasThree = false;
            let hasTwo = false;
            for (let num in counts) {
                if (counts[num] === 3) hasThree = true;
                if (counts[num] === 2) hasTwo = true;
                if (counts[num] === 5) return sum; // 5개 동일도 풀하우스 충족
            }
            if (hasThree && hasTwo) return sum;
            return 0;
        case 'small_straight':
            const keys = Object.keys(counts).map(Number);
            const hasSS = (keys.includes(1) && keys.includes(2) && keys.includes(3) && keys.includes(4)) ||
                          (keys.includes(2) && keys.includes(3) && keys.includes(4) && keys.includes(5)) ||
                          (keys.includes(3) && keys.includes(4) && keys.includes(5) && keys.includes(6));
            return hasSS ? 15 : 0;
        case 'large_straight':
            const keysLS = Object.keys(counts).map(Number);
            const hasLS = (keysLS.includes(1) && keysLS.includes(2) && keysLS.includes(3) && keysLS.includes(4) && keysLS.includes(5)) ||
                          (keysLS.includes(2) && keysLS.includes(3) && keysLS.includes(4) && keysLS.includes(5) && keysLS.includes(6));
            return hasLS ? 30 : 0;
        case 'yacht':
            for (let num in counts) {
                if (counts[num] === 5) return 50;
            }
            return 0;
        default: return 0;
    }
}

// 점수판 점수 업데이트 및 보너스(+35점) 연산
function updatePlayerScores(player) {
    const subtotalCategories = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
    let subtotal = 0;
    subtotalCategories.forEach(cat => {
        if (player.scoreBoard[cat] !== null) {
            subtotal += player.scoreBoard[cat];
        }
    });

    player.bonus = subtotal >= 63 ? 35 : 0;

    let total = player.bonus;
    for (let cat in player.scoreBoard) {
        if (player.scoreBoard[cat] !== null) {
            total += player.scoreBoard[cat];
        }
    }
    player.totalScore = total;
}

io.on('connection', (socket) => {
    console.log(`유저 접속: ${socket.id}`);

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const rId = roomId.trim().toUpperCase();
        const pName = playerName.trim();
        if (!rId || !pName) return;

        socket.roomId = rId;
        socket.playerName = pName;

        if (!rooms[rId]) {
            rooms[rId] = createRoom(rId);
        }

        const room = rooms[rId];

        if (room.stage !== 'lobby') {
            socket.emit('errorMsg', '이미 게임이 진행 중이거나 종료된 방입니다.');
            return;
        }
        if (room.players.length >= 6) {
            socket.emit('errorMsg', '방이 가득 찼습니다. (최대 6명 제한)');
            return;
        }

        const isHost = room.players.length === 0;
        const player = createPlayer(socket.id, pName, isHost);
        room.players.push(player);

        socket.join(rId);
        io.to(rId).emit('roomUpdated', room);
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) return;

        if (room.players.length === 1) {
            // [1인 플레이 예외 처리] 순서 뽑기를 즉시 건너뛰고 바로 play 스테이지 진입
            room.stage = 'play';
            room.activePlayerIdx = 0;
            room.round = 1;
            const p = room.players[0];
            p.sequenceRoll = 1;
            p.rollsLeft = 3;
            p.dice = [1, 1, 1, 1, 1];
            p.kept = [false, false, false, false, false];
        } else {
            // 다인 플레이: 순서 뽑기(sequence) 화면 진입
            room.stage = 'sequence';
            const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
            const shuffled = values.sort(() => Math.random() - 0.5);
            room.cards = Array.from({ length: room.players.length }, (_, i) => ({
                idx: i,
                value: shuffled[i],
                chosenBy: null
            }));
            room.players.forEach(p => p.sequenceRoll = null);
        }
        io.to(room.id).emit('roomUpdated', room);
    });

    // 순서 정하기 단계에서 카드를 골랐을 때
    socket.on('chooseCard', ({ cardIdx }) => {
        const room = rooms[socket.roomId];
        if (!room || room.stage !== 'sequence') return;

        const card = room.cards.find(c => c.idx === cardIdx);
        if (!card || card.chosenBy !== null) return;

        const alreadyPicked = room.cards.some(c => c.chosenBy === socket.id);
        if (alreadyPicked) return;

        card.chosenBy = socket.id;

        // 모든 참가자가 카드를 한 장씩 다 골랐는지 확인
        const allChosen = room.cards.every(c => c.chosenBy !== null);
        if (allChosen) {
            const cardMap = {};
            room.cards.forEach(c => {
                cardMap[c.chosenBy] = c.value;
            });

            // 카드 숫자가 큰 사람이 선공을 잡도록 플레이어 배열 재정렬
            room.players.sort((a, b) => cardMap[b.id] - cardMap[a.id]);

            room.players.forEach((p, idx) => {
                p.sequenceRoll = idx + 1;
                p.rollsLeft = 3;
                p.dice = [1, 1, 1, 1, 1];
                p.kept = [false, false, false, false, false];
            });

            room.activePlayerIdx = 0;
            room.stage = 'play';
            room.round = 1;
        }

        io.to(room.id).emit('roomUpdated', room);
    });

    // 주사위 굴리기
    socket.on('rollDice', () => {
        const room = rooms[socket.roomId];
        if (!room || room.stage !== 'play') return;

        const activePlayer = room.players[room.activePlayerIdx];
        if (activePlayer.id !== socket.id) return;
        if (activePlayer.rollsLeft <= 0) return;

        for (let i = 0; i < 5; i++) {
            if (!activePlayer.kept[i]) {
                activePlayer.dice[i] = Math.floor(Math.random() * 6) + 1;
            }
        }
        activePlayer.rollsLeft -= 1;

        // 클라이언트에 흔들리는 애니메이션을 트리거하기 위해 먼저 이벤트 전송
        io.to(room.id).emit('diceRolled', {
            rollerId: socket.id,
            dice: activePlayer.dice,
            rollsLeft: activePlayer.rollsLeft
        });

        io.to(room.id).emit('roomUpdated', room);
    });

    // 보관할 주사위 상태 반전
    socket.on('toggleKeep', ({ diceIdx }) => {
        const room = rooms[socket.roomId];
        if (!room || room.stage !== 'play') return;

        const activePlayer = room.players[room.activePlayerIdx];
        if (activePlayer.id !== socket.id) return;
        if (activePlayer.rollsLeft === 3) return; // 주사위를 한 번도 굴리지 않은 상황 방지

        if (diceIdx >= 0 && diceIdx < 5) {
            activePlayer.kept[diceIdx] = !activePlayer.kept[diceIdx];
        }

        io.to(room.id).emit('roomUpdated', room);
    });

    // 점수 카테고리 기록 및 턴 넘기기
    socket.on('selectCategory', ({ category }) => {
        const room = rooms[socket.roomId];
        if (!room || room.stage !== 'play') return;

        const activePlayer = room.players[room.activePlayerIdx];
        if (activePlayer.id !== socket.id) return;
        if (activePlayer.rollsLeft === 3) return; // 최소 한 번은 굴려야 기록 가능
        if (activePlayer.scoreBoard[category] !== null) return;

        activePlayer.scoreBoard[category] = calculateScore(category, activePlayer.dice);
        updatePlayerScores(activePlayer);

        // 다음 차례 준비
        activePlayer.rollsLeft = 3;
        activePlayer.dice = [1, 1, 1, 1, 1];
        activePlayer.kept = [false, false, false, false, false];

        room.activePlayerIdx = (room.activePlayerIdx + 1) % room.players.length;

        // 한 바퀴 돌면 라운드 증가
        if (room.activePlayerIdx === 0) {
            room.round += 1;
        }

        // 12라운드가 완전히 끝나면 게임 종료
        if (room.round > room.maxRounds) {
            room.stage = 'end';
            room.players.sort((a, b) => b.totalScore - a.totalScore);
        }

        io.to(room.id).emit('roomUpdated', room);
    });

    // 실시간 이모티콘 리액션 통신 맞춤 완료
    socket.on('sendReaction', ({ reaction }) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        io.to(room.id).emit('receiveReaction', {
            senderId: socket.id,
            reaction: reaction
        });
    });

    socket.on('disconnect', () => {
        console.log(`유저 퇴장: ${socket.id}`);
        const room = rooms[socket.roomId];
        if (!room) return;

        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
            delete rooms[socket.roomId];
        } else {
            const hasHost = room.players.some(p => p.isHost);
            if (!hasHost) {
                room.players[0].isHost = true;
            }
            io.to(room.id).emit('roomUpdated', room);
        }
    });
});

http.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 성공적으로 시작되었습니다.`);
});
