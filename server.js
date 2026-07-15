const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 실시간 게임 룸 관리 객체
const rooms = {};

// 요트 다이스 족보 점수 계산 로직 (서버측 타임아웃 자동 기입용)
function calculateScore(category, dice) {
    const counts = Array(7).fill(0);
    let sum = 0;
    dice.forEach(d => {
        counts[d]++;
        sum += d;
    });

    switch (category) {
        case 'ones': return counts[1] * 1;
        case 'twos': return counts[2] * 2;
        case 'threes': return counts[3] * 3;
        case 'fours': return counts[4] * 4;
        case 'fives': return counts[5] * 5;
        case 'sixes': return counts[6] * 6;
        case 'choice': return sum;
        case 'fourOfAKind':
            for (let i = 1; i <= 6; i++) {
                if (counts[i] >= 4) return i * 4; // 동일 눈 4개의 합
            }
            return 0;
        case 'fullHouse':
            let hasThree = false;
            let hasTwo = false;
            let threeVal = 0, twoVal = 0;
            for (let i = 1; i <= 6; i++) {
                if (counts[i] === 3) { hasThree = true; threeVal = i; }
                if (counts[i] === 2) { hasTwo = true; twoVal = i; }
                if (counts[i] === 5) { hasThree = true; hasTwo = true; threeVal = i; twoVal = i; }
            }
            return (hasThree && hasTwo) ? (threeVal * 3 + twoVal * 2) : 0;
        case 'smallStraight':
            const uniqueStr = Object.keys(counts).filter(k => counts[k] > 0).join('');
            if (/1.*2.*3.*4|2.*3.*4.*5|3.*4.*5.*6/.test(uniqueStr)) return 15;
            return 0;
        case 'largeStraight':
            const uniqueLStr = Object.keys(counts).filter(k => counts[k] > 0).join('');
            if (/1.*2.*3.*4.*5|2.*3.*4.*5.*6/.test(uniqueLStr)) return 30;
            return 0;
        case 'yacht':
            for (let i = 1; i <= 6; i++) {
                if (counts[i] === 5) return 50;
            }
            return 0;
        default: return 0;
    }
}

// AI가 타임아웃 시 최적의 점수 기입 칸을 계산
function getBestCategory(scoreBoard, dice) {
    const categories = [
        'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
        'choice', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yacht'
    ];
    let bestCat = null;
    let maxScore = -1;

    categories.forEach(cat => {
        if (scoreBoard[cat] === null) {
            const score = calculateScore(cat, dice);
            if (score > maxScore) {
                maxScore = score;
                bestCat = cat;
            }
        }
    });

    // 만약 빈 곳이 있다면 점수가 0점이라도 아무 곳이나 선택
    if (!bestCat) {
        bestCat = categories.find(cat => scoreBoard[cat] === null);
    }
    return { category: bestCat, score: maxScore >= 0 ? maxScore : 0 };
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    let myNickname = '알 수 없음';

    // 방 만들기/조인
    socket.on('joinRoom', ({ roomId, nickname }) => {
        currentRoomId = roomId;
        myNickname = nickname;
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                players: [],
                status: 'waiting', // waiting, card_draw, playing, finished
                cards: [], // 순서 결정용 무광 블랙 카드들
                drawCount: 0,
                turnIndex: 0,
                dice: [1, 1, 1, 1, 1],
                kept: [false, false, false, false, false],
                rollsLeft: 3,
                shakeProgress: 0,
                timer: null,
                timeLeft: 45
            };
        }

        const room = rooms[roomId];
        
        // 중복 참여 방지 및 재접속 처리
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (!existingPlayer && room.status === 'waiting') {
            room.players.push({
                id: socket.id,
                nickname: nickname,
                order: null,
                scoreBoard: {
                    ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
                    choice: null, fourOfAKind: null, fullHouse: null, smallStraight: null, largeStraight: null, yacht: null
                },
                bonusEligible: false,
                totalScore: 0
            });
        }

        io.to(roomId).emit('roomUpdate', {
            players: room.players,
            status: room.status,
            cards: room.cards
        });
    });

    // 게임 시작 (카드 뽑기 진입)
    socket.on('startGame', () => {
        const room = rooms[currentRoomId];
        if (!room || room.status !== 'waiting') return;

        if (room.players.length === 1) {
            // 혼자 할 때는 카드 뽑기 생략하고 바로 시작
            room.status = 'playing';
            room.players[0].order = 1;
            startTurn(currentRoomId);
        } else {
            // 멀티플레이어는 무광 검정 카드 뽑기 단계 개시
            room.status = 'card_draw';
            room.drawCount = 0;
            // 인원수만큼 1~n 순서 번호 생성 후 셔플
            const orders = Array.from({ length: room.players.length }, (_, i) => i + 1);
            for (let i = orders.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [orders[i], orders[j]] = [orders[j], orders[i]];
            }

            room.cards = orders.map((orderNum, idx) => ({
                id: idx,
                orderNum: orderNum,
                revealed: false,
                drawnBy: null
            }));

            io.to(currentRoomId).emit('startCardDraw', {
                players: room.players,
                cards: room.cards
            });
        }
    });

    // 카드 뽑기 클릭
    socket.on('drawCard', (cardId) => {
        const room = rooms[currentRoomId];
        if (!room || room.status !== 'card_draw') return;

        const card = room.cards.find(c => c.id === cardId);
        const player = room.players.find(p => p.id === socket.id);

        if (card && !card.revealed && player && player.order === null) {
            card.revealed = true;
            card.drawnBy = player.nickname;
            player.order = card.orderNum;
            room.drawCount++;

            io.to(currentRoomId).emit('cardRevealed', {
                cards: room.cards,
                playerId: socket.id,
                order: card.orderNum
            });

            // 모든 플레이어가 카드를 다 뽑았으면 정렬 후 게임 개시
            if (room.drawCount === room.players.length) {
                room.players.sort((a, b) => a.order - b.order);
                setTimeout(() => {
                    room.status = 'playing';
                    startTurn(currentRoomId);
                }, 2000); // 2초 뒤에 족보판 활성화
            }
        }
    });

    // 턴 시작 및 타이머 가동 함수
    function startTurn(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        clearInterval(room.timer);
        room.rollsLeft = 3;
        room.dice = [1, 1, 1, 1, 1];
        room.kept = [true, true, true, true, true]; // 초기 상태는 컵 안에 들어가 있으므로 전부 홀드 취급 (롤 불가능한 컵 내부 보관 상태)
        room.shakeProgress = 0;
        room.timeLeft = 45;

        const activePlayer = room.players[room.turnIndex];

        io.to(roomId).emit('turnStarted', {
            activePlayerId: activePlayer.id,
            turnIndex: room.turnIndex,
            rollsLeft: room.rollsLeft,
            dice: room.dice,
            kept: room.kept,
            timeLeft: room.timeLeft
        });

        // 45초 타이머 구동
        room.timer = setInterval(() => {
            room.timeLeft--;
            io.to(roomId).emit('timerTick', room.timeLeft);

            if (room.timeLeft <= 0) {
                clearInterval(room.timer);
                autoSelectCategory(roomId);
            }
        }, 1000);
    }

    // 시간 초과 시 자동으로 최적의 기댓값 족보에 0점 혹은 점수 강제 기입
    function autoSelectCategory(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const activePlayer = room.players[room.turnIndex];
        // 컵에 안 빼낸 주사위가 있으면 전부 꺼내진 필드 주사위로 간주해 계산
        const { category, score } = getBestCategory(activePlayer.scoreBoard, room.dice);

        activePlayer.scoreBoard[category] = score;
        
        // 보너스 및 점수 정산
        updateTotalScore(activePlayer);

        io.to(roomId).emit('scoreSelected', {
            playerId: activePlayer.id,
            scoreBoard: activePlayer.scoreBoard,
            totalScore: activePlayer.totalScore,
            category: category,
            score: score,
            isTimeout: true
        });

        nextTurn(roomId);
    }

    // 다음 턴 교대 또는 종료 체크
    function nextTurn(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        clearInterval(room.timer);

        // 전체 플레이어가 12개 칸을 모두 채웠는지 검사
        const isGameOver = room.players.every(p => 
            Object.values(p.scoreBoard).every(val => val !== null)
        );

        if (isGameOver) {
            room.status = 'finished';
            // 총점순 내림차순 정렬
            room.players.sort((a, b) => b.totalScore - a.totalScore);
            io.to(roomId).emit('gameOver', room.players);
        } else {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            startTurn(roomId);
        }
    }

    // 총점 및 보너스 점수(63점 돌파 시 +35점) 계산
    function updateTotalScore(player) {
        const upperCategories = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
        let upperSum = 0;
        let lowerSum = 0;

        upperCategories.forEach(cat => {
            upperSum += (player.scoreBoard[cat] || 0);
        });

        if (upperSum >= 63) {
            player.bonusEligible = true;
        }

        Object.keys(player.scoreBoard).forEach(cat => {
            if (!upperCategories.includes(cat)) {
                lowerSum += (player.scoreBoard[cat] || 0);
            }
        });

        player.totalScore = upperSum + lowerSum + (player.bonusEligible ? 35 : 0);
    }

    // 통에 주사위 넣기
    socket.on('putDiceInCup', () => {
        const room = rooms[currentRoomId];
        if (!room) return;

        // 리롤 횟수가 남아있는 경우에만
        if (room.rollsLeft > 0) {
            // 필드에 꺼내져서 홀드(홈)되지 않은 주사위들을 모두 컵(홀드 상태 true) 속으로 수납
            room.kept = room.kept.map(() => true);
            room.shakeProgress = 0;

            io.to(currentRoomId).emit('dicePutInCup', {
                kept: room.kept
            });
        }
    });

    // 실시간 드래그 컵 흔들기 동기화
    socket.on('shakeCup', (progressDelta) => {
        const room = rooms[currentRoomId];
        if (!room) return;

        room.shakeProgress = Math.min(100, room.shakeProgress + progressDelta);
        io.to(currentRoomId).emit('cupShaking', {
            shakeProgress: room.shakeProgress,
            shakerNickname: myNickname
        });
    });

    // 흔들기 완료 후 주사위 쏟아내기 (리롤 결과 롤링)
    socket.on('rollDice', () => {
        const room = rooms[currentRoomId];
        if (!room || room.rollsLeft <= 0) return;

        room.rollsLeft--;

        // 컵(kept) 상태인 주사위(즉 리롤 대상)들만 완전히 무작위 눈 생성
        for (let i = 0; i < 5; i++) {
            if (room.kept[i]) {
                room.dice[i] = Math.floor(Math.random() * 6) + 1;
            }
        }

        // 굴러 떨어진 직후는 모두 드롭 존(필드)으로 나와 홀드가 해제(false)된 상태
        room.kept = [false, false, false, false, false];
        room.shakeProgress = 0;

        io.to(currentRoomId).emit('diceRolled', {
            dice: room.dice,
            kept: room.kept,
            rollsLeft: room.rollsLeft
        });
    });

    // 주사위를 홀드 홈 ↔ 필드 전환 (드래그/클릭 이동)
    socket.on('toggleKeep', (index) => {
        const room = rooms[currentRoomId];
        if (!room) return;

        // 현재 플레이어의 턴일 때만 조작 허용
        const activePlayer = room.players[room.turnIndex];
        if (activePlayer.id !== socket.id) return;

        room.kept[index] = !room.kept[index];
        io.to(currentRoomId).emit('keepUpdated', room.kept);
    });

    // 족보 점수 기록 확정
    socket.on('selectCategory', (category) => {
        const room = rooms[currentRoomId];
        if (!room || room.status !== 'playing') return;

        const activePlayer = room.players[room.turnIndex];
        if (activePlayer.id !== socket.id) return; // 본인 턴 검증

        if (activePlayer.scoreBoard[category] !== null) return; // 이미 채워진 칸

        // 점수 계산 (홈에 있던 필드에 있던 모든 최종 5개 주사위 기준)
        const score = calculateScore(category, room.dice);
        activePlayer.scoreBoard[category] = score;

        updateTotalScore(activePlayer);

        io.to(currentRoomId).emit('scoreSelected', {
            playerId: socket.id,
            scoreBoard: activePlayer.scoreBoard,
            totalScore: activePlayer.totalScore,
            category: category,
            score: score,
            isTimeout: false
        });

        nextTurn(currentRoomId);
    });

    // 방 나가기 및 연결 끊김 대응
    socket.on('disconnect', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;

        const room = rooms[currentRoomId];
        const playerIndex = room.players.findIndex(p => p.id === socket.id);

        if (playerIndex !== -1) {
            // 중도 퇴장해도 턴이 유지되고 방은 터지지 않음 (기획 사항 반영)
            console.log(`${myNickname} 퇴장.`);
            if (room.players.length === 1) {
                clearInterval(room.timer);
                delete rooms[currentRoomId];
            } else {
                // 게임 중 퇴장 시, 해당 유저의 턴이면 자동 스킵 처리 후 다음 턴
                if (room.status === 'playing' && room.turnIndex === playerIndex) {
                    nextTurn(currentRoomId);
                }
                room.players.splice(playerIndex, 1);
                // 턴 인덱스 동기화 보정
                if (room.turnIndex >= room.players.length) {
                    room.turnIndex = 0;
                }
                io.to(currentRoomId).emit('roomUpdate', {
                    players: room.players,
                    status: room.status,
                    cards: room.cards
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
