'use strict';

// Одна игровая доска: пять вертикальных направляющих, объединённых верхней.
// Координаты задаются в SVG, поэтому поле одинаково работает на ПК и телефоне.
const svg = document.getElementById('board');
const chipLayer = document.getElementById('chips');
const targetLayer = document.getElementById('targets');
const timerEl = document.getElementById('timer');
const undoBtn = document.getElementById('undoBtn');
const resetBtn = document.getElementById('resetBtn');
const hintEl = document.getElementById('hint');
const winScreen = document.getElementById('winScreen');
const finalTimeEl = document.getElementById('finalTime');

const NS = 'http://www.w3.org/2000/svg';
const LANES = [150, 247, 344, 441, 538];
const RAIL_Y = 105;
const STEP = 64;
const ROWS = Array.from({length: 7}, (_, i) => RAIL_Y + STEP * (i + 4));
const STOPS = Array.from({length: 11}, (_, i) => RAIL_Y + STEP * i);
const BOTTOM_Y = STOPS[10];
const MIN_GAP = 57; // Минимальная дистанция между центрами двух фишек.
const EPS = 0.35;

const COLORS = {
  brown: {name: 'Коричневый', base: '#995f68', rim: '#713d4c', light: '#bc808a'},
  pink:  {name: 'Розовый',     base: '#de3fb8', rim: '#a52283', light: '#f376d3'},
  blue:  {name: 'Голубой',     base: '#16afd9', rim: '#0782ad', light: '#67d5eb'},
  orange:{name: 'Оранжевый',   base: '#f08d38', rim: '#b95a23', light: '#ffbb73'},
  red:   {name: 'Красный',     base: '#e6354f', rim: '#b41f40', light: '#fa7585'},
  teal:  {name: 'Бирюзовый',   base: '#4dc3bf', rim: '#298d93', light: '#8de1da'},
  green: {name: 'Зелёный',     base: '#9bcf70', rim: '#679e47', light: '#c8eca0'}
};

// Слева на исходном фото указан именно такой порядок строк сверху вниз.
const TARGET_ORDER = ['brown', 'pink', 'blue', 'orange', 'red', 'teal', 'green'];
// Исходные стопки на фото: сверху — розовый и коричневый,
// ниже по пять фишек одного цвета (слева направо).
const INITIAL_COLUMNS = ['teal', 'red', 'orange', 'blue', 'green'];

let chips = [];
let active = null;
let history = [];
let startedAt = 0;
let elapsedBefore = 0;
let ticker = null;
let solved = false;

function createSvg(tag, attributes = {}, parent) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attributes).forEach(([key, value]) => el.setAttribute(key, value));
  if (parent) parent.appendChild(el);
  return el;
}

function drawTargets() {
  targetLayer.replaceChildren();
  TARGET_ORDER.forEach((colorKey, row) => {
    const c = COLORS[colorKey];
    const g = createSvg('g', {'aria-label': `Ряд ${row + 1}: ${c.name}`}, targetLayer);
    createSvg('circle', {cx: 75, cy: ROWS[row] + 3, r: 25, fill: '#4b352e', opacity: '.20'}, g);
    createSvg('circle', {cx: 75, cy: ROWS[row], r: 23, fill: c.base, stroke: '#d2b792', 'stroke-width': 3}, g);
    createSvg('circle', {cx: 68, cy: ROWS[row] - 7, r: 8, fill: '#fff', opacity: '.12'}, g);
  });
}

function createChipVisual(chip) {
  const c = COLORS[chip.color];
  const g = createSvg('g', {'data-chip-id': chip.id, class: 'chip', 'aria-label': `Фишка: ${c.name}`}, chipLayer);
  createSvg('circle', {class:'outer', r: 29, cy: 0, cx: 0, fill: c.rim}, g);
  createSvg('circle', {class:'rim', r: 26, cy: -2, cx: 0, fill: c.base, stroke: c.light}, g);
  createSvg('circle', {class:'core', r: 20, cy: -3, cx: 0, fill: c.base, stroke: c.rim}, g);
  createSvg('circle', {class:'glint', r: 26, cy: -2, cx: 0, fill: 'url(#metalSheen)'}, g);
  createSvg('ellipse', {class:'glint', cx:-8, cy:-12, rx:9, ry:4, transform:'rotate(-26 -8 -12)', fill:'#fff', opacity:'.17'}, g);
  chip.el = g;
  renderChip(chip);
}

function renderChip(chip) {
  chip.el.setAttribute('transform', `translate(${chip.x.toFixed(2)} ${chip.y.toFixed(2)})`);
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function elapsedMs() {
  return elapsedBefore + (startedAt ? Date.now() - startedAt : 0);
}

function refreshTimer() { timerEl.textContent = formatTime(elapsedMs()); }
function beginTimer() {
  if (startedAt || solved) return;
  startedAt = Date.now();
  ticker = window.setInterval(refreshTimer, 250);
}
function pauseTimer() {
  if (startedAt) elapsedBefore += Date.now() - startedAt;
  startedAt = 0;
  window.clearInterval(ticker);
  ticker = null;
  refreshTimer();
}

function resetGame() {
  if (active) {
    try { svg.releasePointerCapture(active.pointerId); } catch (_) {}
  }
  active = null;
  pauseTimer();
  elapsedBefore = 0;
  solved = false;
  history = [];
  undoBtn.disabled = true;
  winScreen.hidden = true;
  chipLayer.replaceChildren();
  let id = 0;
  chips = [];
  INITIAL_COLUMNS.forEach((baseColor, laneIndex) => {
    const sequence = ['pink', 'brown', baseColor, baseColor, baseColor, baseColor, baseColor];
    sequence.forEach((color, row) => {
      const chip = {id: id++, x: LANES[laneIndex], y: ROWS[row], mode:'v', color, el:null};
      chips.push(chip);
      createChipVisual(chip);
    });
  });
  hintEl.textContent = 'Зажми фишку и веди по пазу. Для смены столбца используй верхнюю дорожку.';
  refreshTimer();
}

// Реальная геометрическая проверка столкновений:
// при движении по прямой нельзя пересечь зону другой фишки.
function moveAlong(chip, axis, desired) {
  const isVertical = axis === 'y';
  const previous = chip[axis];
  const lowerLimit = isVertical ? RAIL_Y : LANES[0];
  const upperLimit = isVertical ? BOTTOM_Y : LANES[LANES.length - 1];
  let target = Math.max(lowerLimit, Math.min(upperLimit, desired));
  if (Math.abs(target - previous) < EPS) return;
  const forward = target > previous;
  for (const other of chips) {
    if (other === chip) continue;
    const across = isVertical ? Math.abs(chip.x - other.x) : Math.abs(chip.y - other.y);
    if (across >= MIN_GAP) continue;
    const half = Math.sqrt(MIN_GAP * MIN_GAP - across * across);
    const center = other[axis];
    const near = center - half;
    const far = center + half;
    if (forward) {
      if (near >= previous - EPS && near < target) target = near;
    } else {
      if (far <= previous + EPS && far > target) target = far;
    }
  }
  chip[axis] = Math.max(lowerLimit, Math.min(upperLimit, target));
}

function nearestLane(x) {
  return LANES.reduce((best, current) => Math.abs(x - current) < Math.abs(x - best) ? current : best, LANES[0]);
}

function pointFromEvent(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  return pt.matrixTransform(matrix.inverse());
}

function followFinger(chip, point) {
  const x = Math.min(LANES[4], Math.max(LANES[0], point.x));
  const y = Math.min(BOTTOM_Y, Math.max(RAIL_Y, point.y));
  if (chip.mode === 'v') {
    moveAlong(chip, 'y', y);
    // В соседнюю вертикаль можно пройти только через ВЕРХНЕЕ соединение.
    if (chip.y <= RAIL_Y + EPS && Math.abs(x - chip.x) > 18 && point.y < RAIL_Y + 120) {
      chip.y = RAIL_Y;
      chip.mode = 'h';
      moveAlong(chip, 'x', x);
    }
  } else {
    // По горизонтали можно скользить, пока не встретилась другая фишка.
    moveAlong(chip, 'x', x);
    const lane = nearestLane(x);
    if (point.y > RAIL_Y + 25 && Math.abs(x - lane) < 33 && Math.abs(chip.x - lane) < 33) {
      moveAlong(chip, 'x', lane);
      if (Math.abs(chip.x - lane) < EPS) {
        chip.x = lane;
        chip.mode = 'v';
        moveAlong(chip, 'y', y);
      }
    }
  }
  renderChip(chip);
}

// Магнитные позиции помогают точно попасть в горизонтальный ряд.
function settle(chip) {
  if (chip.mode === 'v') {
    const ordered = STOPS.slice().sort((a, b) => Math.abs(a - chip.y) - Math.abs(b - chip.y));
    for (const stop of ordered) {
      const prior = chip.y;
      moveAlong(chip, 'y', stop);
      if (Math.abs(chip.y - stop) < EPS) break;
      chip.y = prior;
    }
  } else {
    // На горизонтальной дорожке фишку можно оставить между столбцами.
    const lane = nearestLane(chip.x);
    if (Math.abs(lane - chip.x) < 18) moveAlong(chip, 'x', lane);
  }
  renderChip(chip);
}

function snapshot() {
  return chips.map(chip => ({id:chip.id, x:chip.x, y:chip.y, mode:chip.mode}));
}

function undo() {
  if (active || solved || !history.length) return;
  const before = history.pop();
  before.forEach(old => {
    const chip = chips[old.id];
    chip.x = old.x;
    chip.y = old.y;
    chip.mode = old.mode;
    renderChip(chip);
  });
  undoBtn.disabled = history.length === 0;
}

function checkWin() {
  for (let row = 0; row < ROWS.length; row++) {
    for (const x of LANES) {
      if (!chips.some(c => c.mode === 'v' && Math.abs(c.x - x) < 1 && Math.abs(c.y - ROWS[row]) < 1 && c.color === TARGET_ORDER[row])) return;
    }
  }
  solved = true;
  pauseTimer();
  finalTimeEl.textContent = formatTime(elapsedBefore);
  window.setTimeout(() => { winScreen.hidden = false; }, 350);
}

svg.addEventListener('pointerdown', evt => {
  if (solved || active || (evt.pointerType === 'mouse' && evt.button !== 0)) return;
  const node = evt.target.closest('[data-chip-id]');
  if (!node) return;
  const chip = chips[Number(node.dataset.chipId)];
  const pos = pointFromEvent(evt);
  if (!pos) return;
  evt.preventDefault();
  beginTimer();
  const previous = snapshot();
  active = {chip, pointerId: evt.pointerId, previous, startX: chip.x, startY: chip.y};
  chipLayer.appendChild(chip.el); // Выбранная фишка всегда поверх остальных.
  chip.el.classList.add('dragging');
  svg.setPointerCapture(evt.pointerId);
});

svg.addEventListener('pointermove', evt => {
  if (!active || active.pointerId !== evt.pointerId) return;
  evt.preventDefault();
  const pos = pointFromEvent(evt);
  if (pos) followFinger(active.chip, pos);
});

function finishDrag(evt) {
  if (!active || active.pointerId !== evt.pointerId) return;
  evt.preventDefault();
  const {chip, pointerId, previous, startX, startY} = active;
  active = null;
  chip.el.classList.remove('dragging');
  try { if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId); } catch (_) {}
  settle(chip);
  if (Math.hypot(chip.x - startX, chip.y - startY) > 2) {
    history.push(previous);
    if (history.length > 100) history.shift();
    undoBtn.disabled = false;
    checkWin();
  }
}

svg.addEventListener('pointerup', finishDrag);
svg.addEventListener('pointercancel', finishDrag);
resetBtn.addEventListener('click', resetGame);
undoBtn.addEventListener('click', undo);
document.getElementById('playAgainBtn').addEventListener('click', resetGame);

// Дополнительная защита от случайного перетаскивания браузером.
svg.addEventListener('dragstart', event => event.preventDefault());
drawTargets();
resetGame();
