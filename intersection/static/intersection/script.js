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
    const statQueue = document.getElementById('statQueue');
    const statAvgWait = document.getElementById('statAvgWait');
    const cycleLogEl = document.getElementById('cycleLog');

    let running = false, silenceMode = false, cars = [], simTime = 0;
    let lightState = 'red', lightTimer = 25, currentMode = 'current', currentScenario = 'morning', lightInterval = null;

    // AI state
    let aiDecision = null, aiThinking = false, aiCallCooldown = 0;
    const AI_COOLDOWN_TICKS = 15;

    // Analytics state
    let queueHistory = [];
    let satHistory = [];
    let waitTimes = [];
    let cycleStartTime = 0;
    let cycleCount = 0;
    const MAX_HISTORY = 60;

    const SCENARIOS = {
        morning: { q: 1212, L: 9, name: 'Ранковий пік (08:00–09:00)' },
        day:     { q: 984,  L: 8, name: 'Міжпіковий період (12:00–13:00)' },
        evening: { q: 996,  L: 15, name: 'Вечірній пік (17:30–18:30)' }
    };
    const MODES = {
        current:   { C: 74, Tg: 46, Ty: 3, Tr: 25, x: 1.13, mu: 22 },
        optimized: { C: 86, Tg: 58, Ty: 3, Tr: 25, x: 0.90, mu: 27.67 },
        adaptive:  { C: 86, Tg: 58, Ty: 3, Tr: 25, x: 0.90, mu: 27.67 }
    };

    const ROAD_Y = 200, ROAD_X = 450, STOP_LEFT = 350, STOP_RIGHT = 550,
          STOP_TURN = 235, STOP_ZONE = 150, CAR_LENGTH = 30, MIN_CAR_GAP = 40;

    // ── MINI CHART ENGINE ──────────────────────────────────────────────────

    function drawMiniChart(canvasId, data, color, maxVal, label) {
        const c = document.getElementById(canvasId);
        if (!c) return;
        const cx = c.getContext('2d');
        const W = c.offsetWidth || c.parentElement.clientWidth;
        const H = 120;
        c.width = W;
        c.height = H;

        cx.clearRect(0, 0, W, H);

        // background grid
        cx.strokeStyle = 'rgba(78,205,196,0.08)';
        cx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (H / 4) * i;
            cx.beginPath(); cx.moveTo(0, y); cx.lineTo(W, y); cx.stroke();
        }

        if (data.length < 2) return;

        const points = data.slice(-MAX_HISTORY);
        const max = maxVal || Math.max(...points, 1);
        const stepX = W / (MAX_HISTORY - 1);

        // fill
        cx.beginPath();
        cx.moveTo(0, H);
        points.forEach((v, i) => {
            const x = i * stepX;
            const y = H - (v / max) * (H - 10);
            i === 0 ? cx.lineTo(x, y) : cx.lineTo(x, y);
        });
        cx.lineTo((points.length - 1) * stepX, H);
        cx.closePath();
        cx.fillStyle = color.replace(')', ', 0.15)').replace('rgb', 'rgba');
        cx.fill();

        // line
        cx.beginPath();
        points.forEach((v, i) => {
            const x = i * stepX;
            const y = H - (v / max) * (H - 10);
            i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
        });
        cx.strokeStyle = color;
        cx.lineWidth = 2;
        cx.lineJoin = 'round';
        cx.stroke();

        // latest value label
        const last = points[points.length - 1];
        cx.fillStyle = color;
        cx.font = 'bold 12px Segoe UI';
        cx.textAlign = 'right';
        cx.fillText(typeof last === 'number' ? last.toFixed(label === 'sat' ? 2 : 0) : '0', W - 4, 14);
    }

    // ── CYCLE LOG ──────────────────────────────────────────────────────────

    function logCycle(state, duration, queueAtChange) {
        cycleCount++;
        const isEmpty = cycleLogEl.querySelector('.cycle-empty');
        if (isEmpty) isEmpty.remove();

        const entry = document.createElement('div');
        const cls = state === 'green' ? 'green' : state === 'red' ? 'red' : 'adaptive';
        const label = state === 'green' ? '🟢 Зелений' : state === 'red' ? '🔴 Червоний' : '🟡 Жовтий';
        const modeLabel = currentMode === 'adaptive' ? ' 🤖' : '';
        entry.className = `cycle-entry ${cls}`;
        entry.innerHTML = `<span>${label}${modeLabel} — ${duration}с</span><span class="badge">черга: ${queueAtChange}</span>`;
        cycleLogEl.prepend(entry);

        // keep max 20 entries
        while (cycleLogEl.children.length > 20) {
            cycleLogEl.removeChild(cycleLogEl.lastChild);
        }
    }

    // ── AI LOGIC ───────────────────────────────────────────────────────────

    function getTrafficStats() {
        const stopped = cars.filter(c => c.speed === 0 && c.type === 'car').length;
        const moving  = cars.filter(c => c.speed > 0  && c.type === 'car').length;
        const scenario = SCENARIOS[currentScenario];
        return { stopped, moving, total: stopped + moving, lightState,
                 lightTimer: Math.floor(lightTimer), scenario: scenario.name, q: scenario.q };
    }

    async function askAI(stats) {
        if (aiThinking) return;
        aiThinking = true;
        try {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 1000,
                    system: `You are a traffic light AI controller for a Ukrainian intersection.
Analyze traffic data and return ONLY a JSON object, no markdown:
{"Tg":<int 30-80>,"Tr":<int 15-35>,"x":<float>,"mu":<float>,"reason":"<Ukrainian, max 60 chars>"}
Reduce green if few cars, extend if queue is long.`,
                    messages: [{ role: 'user', content:
                        `Stopped: ${stats.stopped}, Moving: ${stats.moving}, Total: ${stats.total}, ` +
                        `Light: ${stats.lightState}, Timer: ${stats.lightTimer}s, ` +
                        `Scenario: ${stats.scenario}, q: ${stats.q} veh/h` }]
                })
            });
            const data = await res.json();
            const text = data.content.map(i => i.text || '').join('');
            const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
            if (parsed.Tg && parsed.Tr) {
                aiDecision = parsed;
                MODES.adaptive.Tg = Math.min(80, Math.max(30, parsed.Tg));
                MODES.adaptive.Tr = Math.min(35, Math.max(15, parsed.Tr));
                MODES.adaptive.C  = MODES.adaptive.Tg + 3 + MODES.adaptive.Tr;
                MODES.adaptive.x  = isFinite(parsed.x)  ? parsed.x  : 0.90;
                MODES.adaptive.mu = isFinite(parsed.mu) ? parsed.mu : 27.67;
                if (parsed.reason && statusEl) {
                    statusEl.textContent = `🤖 ${parsed.reason}`;
                    setTimeout(() => updateUI(), 3000);
                }
            }
        } catch { fallbackAdaptive(); }
        finally { aiThinking = false; }
    }

    function fallbackAdaptive() {
        const s = getTrafficStats();
        const Tg = s.stopped > 10 ? 78 : s.stopped > 5 ? 68 : 48;
        MODES.adaptive.Tg = Tg;
        MODES.adaptive.C  = Tg + 3 + 25;
        const tg = Tg * 0.4783;
        if (tg > 0) {
            const q = SCENARIOS[currentScenario].q;
            MODES.adaptive.x  = (q * MODES.adaptive.C) / (3600 * tg);
            MODES.adaptive.mu = (3600 / MODES.adaptive.C) * tg;
        }
    }

    // ── ROAD DRAWING ───────────────────────────────────────────────────────

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
        ctx.fillStyle = '#fff'; ctx.setLineDash([8, 8]); ctx.lineWidth = 3;
        for (let i = 0; i < 70; i += 15) { ctx.beginPath(); ctx.moveTo(STOP_LEFT-30, ROAD_Y-35+i); ctx.lineTo(STOP_LEFT-15, ROAD_Y-35+i); ctx.stroke(); }
        for (let i = 0; i < 70; i += 15) { ctx.beginPath(); ctx.moveTo(STOP_RIGHT+15, ROAD_Y-35+i); ctx.lineTo(STOP_RIGHT+30, ROAD_Y-35+i); ctx.stroke(); }
        for (let i = 0; i < 70; i += 15) { ctx.beginPath(); ctx.moveTo(ROAD_X-30+i, STOP_TURN+30); ctx.lineTo(ROAD_X-30+i, STOP_TURN+20); ctx.stroke(); }
        ctx.setLineDash([]);
    }

    function drawTrafficLight(x, y, state) {
        ctx.fillStyle = '#111';
        ctx.fillRect(x, y, 20, 70);
        ctx.fillRect(x - 5, y, 30, 5);
        [{ c: '#e74c3c', s: state==='red' }, { c: '#f1c40f', s: state==='yellow' }, { c: '#2ecc71', s: state==='green' }]
            .forEach((col, i) => {
                ctx.fillStyle = col.s ? col.c : '#333';
                ctx.beginPath(); ctx.arc(x+10, y+15+i*22, 7, 0, Math.PI*2); ctx.fill();
                if (col.s) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
            });
        if (currentMode === 'adaptive') {
            ctx.fillStyle = aiThinking ? '#f1c40f' : (aiDecision ? '#2ecc71' : '#95a5a6');
            ctx.beginPath(); ctx.arc(x+25, y+5, 5, 0, Math.PI*2); ctx.fill();
        }
    }

    function drawCar(x, y, color, dir, turning = false) {
        ctx.fillStyle = color;
        if (dir === 'left') {
            ctx.fillRect(x, y-7, 30, 14); ctx.fillStyle = '#aaddff'; ctx.fillRect(x+15, y-5, 10, 10);
        } else if (dir === 'right') {
            ctx.fillRect(x, y-7, 30, 14); ctx.fillStyle = '#aaddff'; ctx.fillRect(x+5, y-5, 10, 10);
        } else if (dir === 'turnDownLeft' || dir === 'turnDownRight') {
            if (!turning) {
                ctx.fillRect(x, y-7, 30, 14); ctx.fillStyle = '#aaddff';
                if (dir === 'turnDownLeft') ctx.fillRect(x+5, y-5, 10, 10);
                else ctx.fillRect(x+15, y-5, 10, 10);
            } else { ctx.fillRect(x-7, y-15, 14, 30); ctx.fillStyle = '#aaddff'; ctx.fillRect(x-5, y-5, 10, 10); }
        } else if (dir === 'turnLeft' || dir === 'turnRight') {
            if (!turning) {
                ctx.fillRect(x-7, y-15, 14, 30); ctx.fillStyle = '#aaddff'; ctx.fillRect(x-5, y-10, 10, 10);
            } else {
                ctx.fillRect(x, y-7, 30, 14); ctx.fillStyle = '#aaddff';
                if (dir === 'turnLeft') ctx.fillRect(x+15, y-5, 10, 10);
                else ctx.fillRect(x+5, y-5, 10, 10);
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

    // ── CAR SPAWNING & MOVEMENT ────────────────────────────────────────────

    function spawnCar() {
        const rand = Math.random();
        let dir, x, y, color;
        if      (rand < 0.25) { dir = 'left';         x = canvas.width+20;  y = ROAD_Y;          color = '#3498db'; }
        else if (rand < 0.45) { dir = 'turnDownRight'; x = canvas.width+20;  y = ROAD_Y;          color = '#3498db'; }
        else if (rand < 0.65) { dir = 'right';         x = -30;              y = ROAD_Y;          color = '#3498db'; }
        else if (rand < 0.85) { dir = 'turnDownLeft';  x = -30;              y = ROAD_Y;          color = '#3498db'; }
        else if (rand < 0.92) { dir = 'turnLeft';      x = ROAD_X;           y = canvas.height+20; color = '#2ecc71'; }
        else                  { dir = 'turnRight';     x = ROAD_X;           y = canvas.height+20; color = '#2ecc71'; }
        cars.push({ x, y, dir, speed: 1.8, color, active: true, turning: false, type: 'car', waitTime: 0 });
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
                    if (c.turning) c.y += 2; else { if (c.dir === 'turnDownLeft') c.x += 2; else c.x -= 2; }
                } else if (c.dir === 'turnLeft' || c.dir === 'turnRight') {
                    if (!c.turning && c.y <= ROAD_Y+20) c.turning = true;
                    if (c.turning) { if (c.dir === 'turnLeft') c.x -= 2; else c.x += 2; } else c.y -= 2;
                }
                continue;
            }

            let shouldStop = false;
            if (c.dir === 'right') {
                const sp = STOP_LEFT-10;
                if ((lightState==='red'||lightState==='yellow') && c.x<sp && c.x>sp-STOP_ZONE) shouldStop=true;
                for (let o of cars) { if (o!==c&&o.active&&o.dir==='right'){ const d=o.x-(c.x+CAR_LENGTH); if(d>0&&d<MIN_CAR_GAP){shouldStop=true;break;} } }
            } else if (c.dir === 'left') {
                const sp = STOP_RIGHT+10;
                if ((lightState==='red'||lightState==='yellow') && c.x>sp && c.x<sp+STOP_ZONE) shouldStop=true;
                for (let o of cars) { if (o!==c&&o.active&&o.dir==='left'){ const d=c.x-(o.x+CAR_LENGTH); if(d>0&&d<MIN_CAR_GAP){shouldStop=true;break;} } }
            } else if (c.dir === 'turnDownLeft') {
                if (!c.turning) {
                    const sp = STOP_LEFT-10;
                    if ((lightState==='red'||lightState==='yellow') && c.x<sp && c.x>sp-STOP_ZONE) shouldStop=true;
                    if (!shouldStop && Math.abs(c.x-ROAD_X)<20) c.turning=true;
                }
            } else if (c.dir === 'turnDownRight') {
                for (let o of cars) { if (o!==c&&o.active&&o.dir==='turnDownRight'){ const d=o.x-(c.x+CAR_LENGTH); if(d>0&&d<MIN_CAR_GAP){shouldStop=true;break;} } }
                if (!c.turning && Math.abs(c.x-ROAD_X)<20) c.turning=true;
            } else if (c.dir === 'turnLeft') {
                if (!c.turning) { if ((lightState==='red'||lightState==='yellow')&&c.y>STOP_TURN+10&&c.y<STOP_TURN+STOP_ZONE) shouldStop=true; }
                else { if ((lightState==='red'||lightState==='yellow')&&c.x>STOP_LEFT-20&&c.x<STOP_LEFT+50) shouldStop=true; }
            } else if (c.dir === 'turnRight') {
                if (c.turning) { if ((lightState==='red'||lightState==='yellow')&&c.x>STOP_LEFT-20&&c.x<STOP_LEFT+50) shouldStop=true; }
            }

            if (shouldStop) { c.speed = 0; c.waitTime = (c.waitTime || 0) + 1; }
            else { c.speed = 1.8; if (c.waitTime > 0) { waitTimes.push(c.waitTime); if (waitTimes.length > 200) waitTimes.shift(); c.waitTime = 0; } }

            if (c.dir === 'left') c.x -= c.speed;
            else if (c.dir === 'right') c.x += c.speed;
            else if (c.dir === 'turnDownLeft') { if (!c.turning && Math.abs(c.x-ROAD_X)<20) c.turning=true; if(c.turning) c.y+=c.speed; else c.x+=c.speed; }
            else if (c.dir === 'turnDownRight') { if (!c.turning && Math.abs(c.x-ROAD_X)<20) c.turning=true; if(c.turning) c.y+=c.speed; else c.x-=c.speed; }
            else if (c.dir === 'turnLeft' || c.dir === 'turnRight') {
                if (!c.turning && c.y<=ROAD_Y+20) c.turning=true;
                if (c.turning) { if(c.dir==='turnLeft') c.x-=c.speed; else c.x+=c.speed; } else c.y-=c.speed;
            }
            if (c.x<-50||c.x>canvas.width+50||c.y<-50||c.y>canvas.height+50) c.active=false;
        }
    }

    // ── LIGHT TIMER ────────────────────────────────────────────────────────

    let lastLightState = 'red';
    let lastLightChangeTick = 0;

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
                    silenceMode = false; lightState = 'green';
                    lightTimer = MODES[currentMode].Tg || 25;
                    btnSilence.textContent = '🕯️ Хвилина мовчання';
                    btnSilence.classList.remove('active');
                }
                updateUI(); return;
            }

            lightTimer--;

            // record analytics each second
            const qNow = cars.filter(c => c.speed === 0 && c.type === 'car').length;
            queueHistory.push(qNow);
            if (queueHistory.length > MAX_HISTORY) queueHistory.shift();

            const mode = MODES[currentMode];
            const xNow = (typeof mode.x === 'number' && isFinite(mode.x)) ? mode.x : 0.90;
            satHistory.push(xNow);
            if (satHistory.length > MAX_HISTORY) satHistory.shift();

            drawMiniChart('chartQueue', queueHistory, 'rgb(78,205,196)', 20, 'queue');
            drawMiniChart('chartSat',   satHistory,   'rgb(231,76,60)',   2,  'sat');

            if (lightTimer <= 0) {
                const elapsed = queueHistory.length - lastLightChangeTick;
                if (lastLightState !== lightState) {
                    logCycle(lastLightState, elapsed, qNow);
                    lastLightChangeTick = queueHistory.length;
                }
                lastLightState = lightState;

                if (lightState === 'red') {
                    lightState = 'green';
                    lightTimer = currentMode === 'adaptive' ? (MODES.adaptive.Tg||58) : MODES[currentMode].Tg;
                } else if (lightState === 'green') {
                    lightState = 'yellow'; lightTimer = 3;
                } else {
                    lightState = 'red';
                    lightTimer = currentMode === 'adaptive' ? (MODES.adaptive.Tr||25) : MODES[currentMode].Tr;
                }
            }
            updateUI();
        }, 1000);
    }

    function stopLightTimer() {
        if (lightInterval) { clearInterval(lightInterval); lightInterval = null; }
    }

    // ── UI ─────────────────────────────────────────────────────────────────

    function updateUI() {
        const scenarioData = SCENARIOS[currentScenario];
        statusEl.textContent = running
            ? (silenceMode ? '🕯️ Хвилина мовчання' : `Активна (${scenarioData.name})`)
            : 'Очікування';

        const lc = lightState==='red' ? 'light-red' : lightState==='yellow' ? 'light-yellow' : 'light-green';
        const lt = lightState==='red' ? 'Червоний'  : lightState==='yellow' ? 'Жовтий'       : 'Зелений';
        lightStatusEl.innerHTML = `<span class="light-indicator ${lc}"></span> ${lt}`;
        timerDisplayEl.textContent = isNaN(lightTimer) ? 25 : Math.floor(lightTimer);

        // queue & wait stats
        const qNow = cars.filter(c => c.speed === 0 && c.type === 'car').length;
        statQueue.textContent = qNow;
        const avgWait = waitTimes.length > 0
            ? Math.round(waitTimes.reduce((a,b)=>a+b,0) / waitTimes.length / 60)
            : 0;
        statAvgWait.textContent = avgWait + 'с';

        if (currentMode === 'current') {
            statSaturation.textContent = '1.13'; statCapacity.textContent = '22';
            document.getElementById('satImprov').textContent = '→ 0.90 (-20.4%)';
            document.getElementById('satImprov').className = 'stat-improvement negative';
            document.getElementById('capImprov').textContent = '→ 27.7 (+25.8%)';
        } else if (currentMode === 'optimized') {
            statSaturation.textContent = '0.90'; statCapacity.textContent = '27.7';
            document.getElementById('satImprov').textContent = '✓ оптимізовано';
            document.getElementById('satImprov').className = 'stat-improvement';
            document.getElementById('capImprov').textContent = '✓ оптимізовано';
        } else {
            const x  = (typeof MODES.adaptive.x  === 'number' && isFinite(MODES.adaptive.x))  ? MODES.adaptive.x  : 0.90;
            const mu = (typeof MODES.adaptive.mu === 'number' && isFinite(MODES.adaptive.mu)) ? MODES.adaptive.mu : 27.67;
            statSaturation.textContent = x.toFixed(2);
            statCapacity.textContent   = Math.round(mu).toString();
            document.getElementById('satImprov').textContent = aiDecision ? '🤖 AI рішення' : '⏳ очікування AI';
            document.getElementById('satImprov').className = 'stat-improvement';
            document.getElementById('capImprov').textContent = aiDecision ? `Tg=${MODES.adaptive.Tg}с / Tr=${MODES.adaptive.Tr}с` : '—';
        }

        const qTrend = queueHistory.length >= 5
            ? (queueHistory[queueHistory.length-1] > queueHistory[queueHistory.length-5] ? '▲ росте' : '▼ спадає')
            : 'зараз';
        document.getElementById('queueTrend').textContent = qTrend;
        document.getElementById('waitTrend').textContent = waitTimes.length > 0 ? `за ${waitTimes.length} авто` : 'за цикл';
    }

    // ── MAIN LOOP ──────────────────────────────────────────────────────────

    function loop() {
        if (!running) return;
        simTime++;
        const spawnRate = currentMode==='optimized'||currentMode==='adaptive' ? 0.8 : 1;
        if (simTime % Math.floor(60/spawnRate) === 0 && !silenceMode) spawnCar();
        updateCars(); draw();
        setTimeout(loop, 16);
    }

    // ── BUTTON HANDLERS ────────────────────────────────────────────────────

    btnToggle.onclick = () => {
        if (running) {
            running=false; stopLightTimer();
            btnToggle.innerHTML='<span>▶</span> Запустити';
            btnToggle.className='action-btn btn-start';
        } else {
            running=true; startLightTimer();
            btnToggle.innerHTML='<span>⏸</span> Зупинити';
            btnToggle.className='action-btn btn-stop';
            loop();
        }
    };

    btnAmbulance.onclick = () => {
        const dirs = ['turnLeft','turnRight','turnDownLeft','turnDownRight'];
        cars.push({ x:ROAD_X, y:canvas.height+20, dir:dirs[Math.floor(Math.random()*4)],
                    speed:3, color:'#e74c3c', active:true, turning:false, type:'amb', waitTime:0 });
    };

    btnSilence.onclick = () => {
        silenceMode = !silenceMode;
        if (silenceMode) {
            lightState='red'; lightTimer=60;
            btnSilence.textContent='🕯️ Завершити'; btnSilence.classList.add('active');
        } else {
            lightState='green'; lightTimer=MODES[currentMode].Tg||25;
            btnSilence.textContent='🕯️ Хвилина мовчання'; btnSilence.classList.remove('active');
        }
        updateUI();
    };

    scenarioBtns.forEach(btn => {
        btn.onclick = () => {
            scenarioBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active'); currentScenario=btn.dataset.scenario; updateUI();
        };
    });

    modeCurrent.onclick = () => {
        currentMode='current'; modeCurrent.classList.add('active');
        modeOptimized.classList.remove('active'); modeAdaptive.classList.remove('active');
        lightTimer=MODES.current.Tr; lightState='red'; aiDecision=null; updateUI();
    };
    modeOptimized.onclick = () => {
        currentMode='optimized'; modeOptimized.classList.add('active');
        modeCurrent.classList.remove('active'); modeAdaptive.classList.remove('active');
        lightTimer=MODES.optimized.Tr; lightState='red'; aiDecision=null; updateUI();
    };
    modeAdaptive.onclick = () => {
        currentMode='adaptive'; modeAdaptive.classList.add('active');
        modeCurrent.classList.remove('active'); modeOptimized.classList.remove('active');
        lightTimer=MODES.adaptive.Tr; lightState='red';
        MODES.adaptive.Tg=58; MODES.adaptive.C=86; MODES.adaptive.x=0.90; MODES.adaptive.mu=27.67;
        aiDecision=null; aiCallCooldown=0; updateUI();
    };

    draw(); updateUI();
});

// ── 3D CARD TILT (desktop only) ───────────────────────────────────────────

const isTouchDevice = window.matchMedia('(hover: none)').matches;
if (!isTouchDevice) {
    document.querySelectorAll('.simulation-card, .controls-card, .stats-card, .chart-card').forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const rotateX = ((e.clientY-rect.top)  / rect.height - 0.5) * -20;
            const rotateY = ((e.clientX-rect.left) / rect.width  - 0.5) *  20;
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