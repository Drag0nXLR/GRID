document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('sim');
    const ctx = canvas.getContext('2d');
    const btnToggle = document.getElementById('btnToggle');
    const btnAmbulance = document.getElementById('btnAmbulance');
    const btnSilence = document.getElementById('btnSilence');
    const modeCurrent = document.getElementById('modeCurrent');
    const modeOptimized = document.getElementById('modeOptimized');
    const modeAdaptive = document.getElementById('modeAdaptive');
    const scenarioBtns = document.querySelectorAll('.scenario-btn');
    const statusEl = document.getElementById('status');
    const lightStatusEl = document.getElementById('lightStatus');
    const carCountEl = document.getElementById('carCount');
    const timerDisplayEl = document.getElementById('timerDisplay');
    const statSaturation = document.getElementById('statSaturation');
    const statCapacity = document.getElementById('statCapacity');

    let running = false, silenceMode = false, cars = [], simTime = 0;
    let lightState = 'red', lightTimer = 25, currentMode = 'current', currentScenario = 'morning', lightInterval = null;

    // AI adaptive state
    let aiDecision = null;
    let aiThinking = false;
    let aiCallCooldown = 0;
    const AI_COOLDOWN_TICKS = 15;

    const SCENARIOS = {
        morning: { q: 1212, L: 9, name: 'Ранковий пік (08:00–09:00)' },
        day: { q: 984, L: 8, name: 'Міжпіковий період (12:00–13:00)' },
        evening: { q: 996, L: 15, name: 'Вечірній пік (17:30–18:30)' }
    };
    const MODES = {
        current: { C: 74, Tg: 46, Ty: 3, Tr: 25, x: 1.13, mu: 22 },
        optimized: { C: 86, Tg: 58, Ty: 3, Tr: 25, x: 0.90, mu: 27.67 },
        adaptive: { C: 86, Tg: 58, Ty: 3, Tr: 25, x: 0.90, mu: 27.67 }
    };

    const ROAD_Y = 200, ROAD_X = 450, STOP_LEFT = 350, STOP_RIGHT = 550, STOP_TURN = 235, STOP_ZONE = 150, CAR_LENGTH = 30, MIN_CAR_GAP = 40;

    // ── AI ADAPTIVE LOGIC ──────────────────────────────────────────────────────

    function getTrafficStats() {
        const stopped = cars.filter(c => c.speed === 0 && c.type === 'car').length;
        const moving = cars.filter(c => c.speed > 0 && c.type === 'car').length;
        const total = stopped + moving;
        const scenario = SCENARIOS[currentScenario];
        return { stopped, moving, total, lightState, lightTimer: Math.floor(lightTimer), scenario: scenario.name, q: scenario.q };
    }

    async function askAI(stats) {
        if (aiThinking) return;
        aiThinking = true;

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 1000,
                    system: `You are a traffic light AI controller for a Ukrainian intersection. 
Analyze traffic data and return ONLY a JSON object with no extra text or markdown:
{
  "Tg": <green phase duration in seconds, integer 30-80>,
  "Tr": <red phase duration in seconds, integer 15-35>,
  "x": <saturation coefficient, float>,
  "mu": <capacity vehicles/hour, float>,
  "reason": "<short Ukrainian explanation, max 60 chars>"
}
Base decisions on: queue length, flow rate, time of day. Reduce green if few cars waiting, extend if queue is long.`,
                    messages: [{
                        role: 'user',
                        content: `Traffic data:
- Stopped cars: ${stats.stopped}
- Moving cars: ${stats.moving}
- Total cars: ${stats.total}
- Current light: ${stats.lightState}
- Timer remaining: ${stats.lightTimer}s
- Scenario: ${stats.scenario}
- Flow rate q: ${stats.q} veh/hour
Optimize the signal timing.`
                    }]
                })
            });

            const data = await response.json();
            const text = data.content.map(i => i.text || '').join('');
            const clean = text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(clean);

            if (parsed.Tg && parsed.Tr) {
                aiDecision = parsed;
                MODES.adaptive.Tg = Math.min(80, Math.max(30, parsed.Tg));
                MODES.adaptive.Tr = Math.min(35, Math.max(15, parsed.Tr));
                MODES.adaptive.C = MODES.adaptive.Tg + 3 + MODES.adaptive.Tr;
                MODES.adaptive.x = typeof parsed.x === 'number' && isFinite(parsed.x) ? parsed.x : 0.90;
                MODES.adaptive.mu = typeof parsed.mu === 'number' && isFinite(parsed.mu) ? parsed.mu : 27.67;

                if (parsed.reason && statusEl) {
                    statusEl.textContent = `🤖 ${parsed.reason}`;
                    setTimeout(() => updateUI(), 3000);
                }
            }
        } catch (err) {
            console.warn('AI call failed, using fallback logic', err);
            fallbackAdaptive();
        } finally {
            aiThinking = false;
        }
    }

    function fallbackAdaptive() {
        const stats = getTrafficStats();
        const baseTg = 58;
        let Tg;
        if (stats.stopped > 10) Tg = Math.min(baseTg + 20, 80);
        else if (stats.stopped > 5) Tg = Math.min(baseTg + 10, 70);
        else Tg = Math.max(baseTg - 10, 30);
        MODES.adaptive.Tg = Tg;
        MODES.adaptive.C = Tg + 3 + 25;
        const tg = Tg * 0.4783;
        if (tg > 0) {
            const q = SCENARIOS[currentScenario].q;
            MODES.adaptive.x = (q * MODES.adaptive.C) / (3600 * tg);
            MODES.adaptive.mu = (3600 / MODES.adaptive.C) * tg;
        }
    }

    // ── ROAD DRAWING ───────────────────────────────────────────────────────────

    function drawRoad() {
        ctx.fillStyle = '#555';
        ctx.fillRect(0, ROAD_Y - 35, canvas.width, 70);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(0, ROAD_Y, canvas.width, 10);
        ctx.strokeStyle = '#fff'; ctx.setLineDash([15, 10]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, ROAD_Y - 35); ctx.lineTo(canvas.width, ROAD_Y - 35); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, ROAD_Y + 35); ctx.lineTo(canvas.width, ROAD_Y + 35); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#555';
        ctx.fillRect(ROAD_X - 35, ROAD_Y, 70, canvas.height - ROAD_Y);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(ROAD_X - 5, ROAD_Y, 10, canvas.height - ROAD_Y);

        ctx.fillStyle = '#666';
        ctx.fillRect(STOP_LEFT, ROAD_Y - 35, STOP_RIGHT - STOP_LEFT, 70);
        ctx.fillRect(ROAD_X - 35, ROAD_Y, 70, STOP_TURN - ROAD_Y);

        ctx.fillStyle = '#fff';
        ctx.fillRect(STOP_LEFT, ROAD_Y - 35, 8, 70);
        ctx.fillRect(STOP_RIGHT, ROAD_Y - 35, 8, 70);
        ctx.fillRect(ROAD_X - 35, STOP_TURN, 70, 8);

        ctx.fillStyle = '#fff';
        ctx.setLineDash([8, 8]);
        ctx.lineWidth = 3;
        for (let i = 0; i < 70; i += 15) {
            ctx.beginPath(); ctx.moveTo(STOP_LEFT - 30, ROAD_Y - 35 + i); ctx.lineTo(STOP_LEFT - 15, ROAD_Y - 35 + i); ctx.stroke();
        }
        for (let i = 0; i < 70; i += 15) {
            ctx.beginPath(); ctx.moveTo(STOP_RIGHT + 15, ROAD_Y - 35 + i); ctx.lineTo(STOP_RIGHT + 30, ROAD_Y - 35 + i); ctx.stroke();
        }
        for (let i = 0; i < 70; i += 15) {
            ctx.beginPath(); ctx.moveTo(ROAD_X - 30 + i, STOP_TURN + 30); ctx.lineTo(ROAD_X - 30 + i, STOP_TURN + 20); ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    function drawTrafficLight(x, y, state) {
        ctx.fillStyle = '#111';
        ctx.fillRect(x, y, 20, 70);
        ctx.fillRect(x - 5, y, 30, 5);
        const colors = [
            { c: '#e74c3c', s: state === 'red' },
            { c: '#f1c40f', s: state === 'yellow' },
            { c: '#2ecc71', s: state === 'green' }
        ];
        colors.forEach((col, i) => {
            ctx.fillStyle = col.s ? col.c : '#333';
            ctx.beginPath();
            ctx.arc(x + 10, y + 15 + i * 22, 7, 0, Math.PI * 2);
            ctx.fill();
            if (col.s) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
        });

        if (currentMode === 'adaptive') {
            ctx.fillStyle = aiThinking ? '#f1c40f' : (aiDecision ? '#2ecc71' : '#95a5a6');
            ctx.beginPath();
            ctx.arc(x + 25, y + 5, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawCar(x, y, color, dir, turning = false) {
        ctx.fillStyle = color;
        if (dir === 'left') {
            ctx.fillRect(x, y - 7, 30, 14);
            ctx.fillStyle = '#aaddff'; ctx.fillRect(x + 15, y - 5, 10, 10);
        } else if (dir === 'right') {
            ctx.fillRect(x, y - 7, 30, 14);
            ctx.fillStyle = '#aaddff'; ctx.fillRect(x + 5, y - 5, 10, 10);
        } else if (dir === 'turnDownLeft' || dir === 'turnDownRight') {
            if (!turning) {
                ctx.fillRect(x, y - 7, 30, 14);
                ctx.fillStyle = '#aaddff';
                if (dir === 'turnDownLeft') ctx.fillRect(x + 5, y - 5, 10, 10);
                else ctx.fillRect(x + 15, y - 5, 10, 10);
            } else {
                ctx.fillRect(x - 7, y - 15, 14, 30);
                ctx.fillStyle = '#aaddff'; ctx.fillRect(x - 5, y - 5, 10, 10);
            }
        } else if (dir === 'turnLeft' || dir === 'turnRight') {
            if (!turning) {
                ctx.fillRect(x - 7, y - 15, 14, 30);
                ctx.fillStyle = '#aaddff'; ctx.fillRect(x - 5, y - 10, 10, 10);
            } else {
                ctx.fillRect(x, y - 7, 30, 14);
                ctx.fillStyle = '#aaddff';
                if (dir === 'turnLeft') ctx.fillRect(x + 15, y - 5, 10, 10);
                else ctx.fillRect(x + 5, y - 5, 10, 10);
            }
        }
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawRoad();
        drawTrafficLight(340, 90, lightState);
        cars.forEach(c => { if (c.active) drawCar(c.x, c.y, c.color, c.dir, c.turning); });
        carCountEl.textContent = cars.filter(c => c.active).length;
    }

    // ── CAR SPAWNING & MOVEMENT ────────────────────────────────────────────────

    function spawnCar() {
        const rand = Math.random();
        let dir, x, y, color;
        if (rand < 0.25) { dir = 'left'; x = canvas.width + 20; y = ROAD_Y; color = '#3498db'; }
        else if (rand < 0.45) { dir = 'turnDownRight'; x = canvas.width + 20; y = ROAD_Y; color = '#3498db'; }
        else if (rand < 0.65) { dir = 'right'; x = -30; y = ROAD_Y; color = '#3498db'; }
        else if (rand < 0.85) { dir = 'turnDownLeft'; x = -30; y = ROAD_Y; color = '#3498db'; }
        else if (rand < 0.92) { dir = 'turnLeft'; x = ROAD_X; y = canvas.height + 20; color = '#2ecc71'; }
        else { dir = 'turnRight'; x = ROAD_X; y = canvas.height + 20; color = '#2ecc71'; }
        cars.push({ x, y, dir, speed: 1.8, color, active: true, turning: false, type: 'car' });
    }

    function updateCars() {
        for (let i = cars.length - 1; i >= 0; i--) {
            const c = cars[i];
            if (!c.active) { cars.splice(i, 1); continue; }
            if (silenceMode && c.type !== 'amb') { c.speed = 0; continue; }
            if (c.type === 'amb') {
                if (c.dir === 'left') c.x -= 2;
                else if (c.dir === 'right') c.x += 2;
                else if (c.dir === 'turnDownLeft' || c.dir === 'turnDownRight') {
                    if (!c.turning && Math.abs(c.x - ROAD_X) < 20) c.turning = true;
                    if (c.turning) c.y += 2;
                    else { if (c.dir === 'turnDownLeft') c.x += 2; else c.x -= 2; }
                } else if (c.dir === 'turnLeft' || c.dir === 'turnRight') {
                    if (!c.turning && c.y <= ROAD_Y + 20) c.turning = true;
                    if (c.turning) { if (c.dir === 'turnLeft') c.x -= 2; else c.x += 2; }
                    else c.y -= 2;
                }
                continue;
            }

            let shouldStop = false;
            if (c.dir === 'right') {
                const sp = STOP_LEFT - 10;
                if ((lightState === 'red' || lightState === 'yellow') && c.x < sp && c.x > sp - STOP_ZONE) shouldStop = true;
                for (let other of cars) {
                    if (other !== c && other.active && other.dir === 'right') {
                        const dist = other.x - (c.x + CAR_LENGTH);
                        if (dist > 0 && dist < MIN_CAR_GAP) { shouldStop = true; break; }
                    }
                }
            } else if (c.dir === 'left') {
                const sp = STOP_RIGHT + 10;
                if ((lightState === 'red' || lightState === 'yellow') && c.x > sp && c.x < sp + STOP_ZONE) shouldStop = true;
                for (let other of cars) {
                    if (other !== c && other.active && other.dir === 'left') {
                        const dist = c.x - (other.x + CAR_LENGTH);
                        if (dist > 0 && dist < MIN_CAR_GAP) { shouldStop = true; break; }
                    }
                }
            } else if (c.dir === 'turnDownLeft') {
                if (!c.turning) {
                    const sp = STOP_LEFT - 10;
                    if ((lightState === 'red' || lightState === 'yellow') && c.x < sp && c.x > sp - STOP_ZONE) shouldStop = true;
                    if (!shouldStop && Math.abs(c.x - ROAD_X) < 20) c.turning = true;
                }
            } else if (c.dir === 'turnDownRight') {
                for (let other of cars) {
                    if (other !== c && other.active && other.dir === 'turnDownRight') {
                        const dist = other.x - (c.x + CAR_LENGTH);
                        if (dist > 0 && dist < MIN_CAR_GAP) { shouldStop = true; break; }
                    }
                }
                if (!c.turning && Math.abs(c.x - ROAD_X) < 20) c.turning = true;
            } else if (c.dir === 'turnLeft') {
                if (!c.turning) {
                    if ((lightState === 'red' || lightState === 'yellow') && c.y > STOP_TURN + 10 && c.y < STOP_TURN + STOP_ZONE) shouldStop = true;
                } else {
                    if ((lightState === 'red' || lightState === 'yellow') && c.x > STOP_LEFT - 20 && c.x < STOP_LEFT + 50) shouldStop = true;
                }
            } else if (c.dir === 'turnRight') {
                if (c.turning) {
                    if ((lightState === 'red' || lightState === 'yellow') && c.x > STOP_LEFT - 20 && c.x < STOP_LEFT + 50) shouldStop = true;
                }
            }

            c.speed = shouldStop ? 0 : 1.8;
            if (c.dir === 'left') c.x -= c.speed;
            else if (c.dir === 'right') c.x += c.speed;
            else if (c.dir === 'turnDownLeft') {
                if (!c.turning && Math.abs(c.x - ROAD_X) < 20) c.turning = true;
                if (c.turning) c.y += c.speed; else c.x += c.speed;
            } else if (c.dir === 'turnDownRight') {
                if (!c.turning && Math.abs(c.x - ROAD_X) < 20) c.turning = true;
                if (c.turning) c.y += c.speed; else c.x -= c.speed;
            } else if (c.dir === 'turnLeft' || c.dir === 'turnRight') {
                if (!c.turning && c.y <= ROAD_Y + 20) c.turning = true;
                if (c.turning) { if (c.dir === 'turnLeft') c.x -= c.speed; else c.x += c.speed; }
                else c.y -= c.speed;
            }
            if (c.x < -50 || c.x > canvas.width + 50 || c.y < -50 || c.y > canvas.height + 50) c.active = false;
        }
    }

    // ── LIGHT TIMER ────────────────────────────────────────────────────────────

    function startLightTimer() {
        if (lightInterval) clearInterval(lightInterval);
        lightInterval = setInterval(() => {
            if (!running) return;

            if (currentMode === 'adaptive') {
                aiCallCooldown--;
                if (aiCallCooldown <= 0 && !aiThinking) {
                    aiCallCooldown = AI_COOLDOWN_TICKS;
                    askAI(getTrafficStats());
                }
            }

            if (silenceMode) {
                lightTimer--;
                if (lightTimer <= 0) {
                    silenceMode = false;
                    lightState = 'green';
                    lightTimer = MODES[currentMode].Tg || 25;
                    btnSilence.textContent = '🕯️ Хвилина мовчання';
                    btnSilence.classList.remove('active');
                }
                updateUI(); return;
            }

            lightTimer--;
            if (lightTimer <= 0) {
                if (lightState === 'red') {
                    lightState = 'green';
                    lightTimer = currentMode === 'adaptive' ? (MODES.adaptive.Tg || 58) : MODES[currentMode].Tg;
                } else if (lightState === 'green') {
                    lightState = 'yellow';
                    lightTimer = 3;
                } else {
                    lightState = 'red';
                    lightTimer = currentMode === 'adaptive' ? (MODES.adaptive.Tr || 25) : MODES[currentMode].Tr;
                }
            }
            updateUI();
        }, 1000);
    }

    function stopLightTimer() {
        if (lightInterval) { clearInterval(lightInterval); lightInterval = null; }
    }

    // ── UI ─────────────────────────────────────────────────────────────────────

    function updateUI() {
        const scenarioData = SCENARIOS[currentScenario];
        statusEl.textContent = running ? (silenceMode ? '🕯️ Хвилина мовчання' : `Активна (${scenarioData.name})`) : 'Очікування';
        let lightColor = lightState === 'red' ? 'light-red' : lightState === 'yellow' ? 'light-yellow' : 'light-green';
        let lightText = lightState === 'red' ? 'Червоний' : lightState === 'yellow' ? 'Жовтий' : 'Зелений';
        lightStatusEl.innerHTML = `<span class="light-indicator ${lightColor}"></span> ${lightText}`;
        const displayTimer = isNaN(lightTimer) ? 25 : Math.floor(lightTimer);
        timerDisplayEl.textContent = displayTimer;

        if (currentMode === 'current') {
            statSaturation.textContent = '1.13';
            statCapacity.textContent = '22';
        } else if (currentMode === 'optimized') {
            statSaturation.textContent = '0.90';
            statCapacity.textContent = '27.7';
        } else {
            const x = (typeof MODES.adaptive.x === 'number' && isFinite(MODES.adaptive.x)) ? MODES.adaptive.x : 0.90;
            const mu = (typeof MODES.adaptive.mu === 'number' && isFinite(MODES.adaptive.mu)) ? MODES.adaptive.mu : 27.67;
            statSaturation.textContent = x.toFixed(2);
            statCapacity.textContent = Math.round(mu).toString();
        }
    }

    // ── MAIN LOOP ──────────────────────────────────────────────────────────────

    function loop() {
        if (!running) return;
        simTime++;
        const spawnRate = currentMode === 'optimized' || currentMode === 'adaptive' ? 0.8 : 1;
        if (simTime % Math.floor(60 / spawnRate) === 0 && !silenceMode) spawnCar();
        updateCars(); draw();
        setTimeout(loop, 16);
    }

    // ── BUTTON HANDLERS ────────────────────────────────────────────────────────

    btnToggle.onclick = () => {
        if (running) {
            running = false; stopLightTimer();
            btnToggle.innerHTML = '<span>▶</span> Запустити';
            btnToggle.className = 'action-btn btn-start';
        } else {
            running = true; startLightTimer();
            btnToggle.innerHTML = '<span>⏸</span> Зупинити';
            btnToggle.className = 'action-btn btn-stop';
            loop();
        }
    };

    btnAmbulance.onclick = () => {
        const directions = ['turnLeft', 'turnRight', 'turnDownLeft', 'turnDownRight'];
        const randomDir = directions[Math.floor(Math.random() * directions.length)];
        cars.push({ x: ROAD_X, y: canvas.height + 20, dir: randomDir, speed: 3, color: '#e74c3c', active: true, turning: false, type: 'amb' });
    };

    btnSilence.onclick = () => {
        silenceMode = !silenceMode;
        if (silenceMode) {
            lightState = 'red'; lightTimer = 60;
            btnSilence.textContent = '🕯️ Завершити';
            btnSilence.classList.add('active');
        } else {
            lightState = 'green';
            lightTimer = MODES[currentMode].Tg || 25;
            btnSilence.textContent = '🕯️ Хвилина мовчання';
            btnSilence.classList.remove('active');
        }
        updateUI();
    };

    scenarioBtns.forEach(btn => {
        btn.onclick = () => {
            scenarioBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentScenario = btn.dataset.scenario;
            updateUI();
        };
    });

    modeCurrent.onclick = () => {
        currentMode = 'current';
        modeCurrent.classList.add('active');
        modeOptimized.classList.remove('active');
        modeAdaptive.classList.remove('active');
        lightTimer = MODES.current.Tr; lightState = 'red';
        aiDecision = null;
        updateUI();
    };

    modeOptimized.onclick = () => {
        currentMode = 'optimized';
        modeOptimized.classList.add('active');
        modeCurrent.classList.remove('active');
        modeAdaptive.classList.remove('active');
        lightTimer = MODES.optimized.Tr; lightState = 'red';
        aiDecision = null;
        updateUI();
    };

    modeAdaptive.onclick = () => {
        currentMode = 'adaptive';
        modeAdaptive.classList.add('active');
        modeCurrent.classList.remove('active');
        modeOptimized.classList.remove('active');
        lightTimer = MODES.adaptive.Tr; lightState = 'red';
        MODES.adaptive.Tg = 58;
        MODES.adaptive.C = 86;
        MODES.adaptive.x = 0.90;
        MODES.adaptive.mu = 27.67;
        aiDecision = null;
        aiCallCooldown = 0;
        updateUI();
    };

    draw();
    updateUI();
});

// ── 3D CARD TILT (desktop only) ───────────────────────────────────────────────

const isTouchDevice = window.matchMedia('(hover: none)').matches;

if (!isTouchDevice) {
    document.querySelectorAll('.simulation-card, .controls-card, .stats-card').forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const rotateX = ((y / rect.height) - 0.5) * -20;
            const rotateY = ((x / rect.width) - 0.5) * 20;
            card.style.transform = `perspective(10000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.02)`;
            card.style.boxShadow = '0 12px 50px rgba(78, 205, 196, 0.3)';
            card.style.borderColor = 'rgba(78, 205, 196, 0.4)';
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = 'perspective(10000px) rotateX(0deg) rotateY(0deg) scale(1)';
            card.style.boxShadow = '';
            card.style.borderColor = '';
        });
    });
}