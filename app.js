const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  data: null,
  meta: null,
  pred: [],
  cache: null,
  cacheRows: [],
  model: 'arw',
  tab: 'forecast',
  animation: null,
  corrTimer: null,
  corrMatrices: new Map(),
  corrIndex: 0,
  calcToken: 0
};

const fmt = (v, d = 4) =>
  Number.isFinite(v)
    ? v.toLocaleString('pt-BR', {
        maximumFractionDigits: d,
        minimumFractionDigits: d
      })
    : '—';

const dateFmt = ms =>
  new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  });

const short = col => col.split('_').slice(-2).join('_');

function status(msg) {
  const el = $('#run-status');
  if (el) el.textContent = msg;
}

/* =========================================================
   DATAS
   ========================================================= */

function parseDate(s) {
  s = String(s || '').trim();

  if (!s) return NaN;

  // dd/mm/yyyy ou dd/mm/yyyy hh:mm:ss
  const br = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (br) {
    const day = br[1].padStart(2, '0');
    const month = br[2].padStart(2, '0');
    const year = br[3];
    const hour = (br[4] || '00').padStart(2, '0');
    const minute = (br[5] || '00').padStart(2, '0');
    const second = (br[6] || '00').padStart(2, '0');

    return Date.parse(
      `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
    );
  }

  // yyyy-mm-dd hh:mm:ss
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) {
    s = s.replace(' ', 'T');
  }

  // Se não houver timezone, considera UTC
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    s += 'Z';
  }

  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function dateInput(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

/* =========================================================
   DADOS
   ========================================================= */

function readValue(i, j) {
  return state.data.values[i * state.data.cols.length + j];
}

function getCol(j) {
  const n = state.data.times.length;
  const a = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    a[i] = readValue(i, j);
  }

  return a;
}

function atOrAfter(ms) {
  const t = state.data.times;
  let lo = 0;
  let hi = t.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (t[mid] < ms) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

/* =========================================================
   CONFIGURAÇÕES
   ========================================================= */

function getSettings() {
  const cols = state.data.cols;

  const target = cols.indexOf($('#target').value);
  const model = $('#model').value;

  let features = $$('#features input:checked')
    .map(x => cols.indexOf(x.value))
    .filter(x => x >= 0 && x !== target);

  // Modelos AR usam o próprio alvo como variável explicativa
  if (model.startsWith('ar')) {
    features.push(target);
  }

  return {
    target,
    features,
    train: Math.floor(+$('#train').value),
    horizon: Math.floor(+$('#horizon').value),
    lag: Math.floor(+$('#lag').value),
    windows: Math.floor(+$('#windows').value),
    model,
    start: Date.parse($('#start').value + 'Z'),
    forecastStart: Date.parse($('#forecast-start').value + 'Z'),
    endDate: Date.parse($('#forecast-end').value + 'Z')
  };
}

function initControls() {
  const d = state.data;
  const m = state.meta;

  $('#target').replaceChildren(
    ...d.cols.map(c => new Option(c, c))
  );

  $('#target').value =
    d.cols.includes(m.defaultTarget)
      ? m.defaultTarget
      : d.cols[0];

  $('#train').value = Math.min(
    m.defaultTrain || 4320,
    Math.max(20, Math.floor(d.times.length / 3))
  );

  $('#start').min = dateInput(d.times[0]);
  $('#start').max = dateInput(d.times[d.times.length - 1]);
  $('#start').value = dateInput(d.times[0]);

  $('#forecast-start').min = dateInput(d.times[0]);
  $('#forecast-start').max = dateInput(d.times[d.times.length - 1]);
  $('#forecast-start').value = dateInput(
    d.times[
      Math.min(
        Math.max(20, Math.floor(d.times.length / 3)),
        d.times.length - 1
      )
    ]
  );

  $('#forecast-end').min = dateInput(d.times[0]);
  $('#forecast-end').max = dateInput(d.times[d.times.length - 1]);
  $('#forecast-end').value =
    dateInput(d.times[d.times.length - 1]);

  $('#series-extra').replaceChildren(
    new Option('Nenhuma', ''),
    ...d.cols.map(c => new Option(c, c))
  );

  $('#cache-from').value =
    new Date(d.times[0]).toISOString().slice(0, 10);

  $('#cache-to').value =
    new Date(d.times[d.times.length - 1])
      .toISOString()
      .slice(0, 10);

  renderFeatures();

  state.corrMatrices.clear();

  $('#dataset-name').textContent =
    `${d.name} · ${d.times.length.toLocaleString('pt-BR')} pontos`;

  $('#series-count').textContent =
    `${d.cols.length} variáveis · ${d.times.length.toLocaleString('pt-BR')} medições`;

  $('#series-range').textContent =
    `${dateFmt(d.times[0])} — ${dateFmt(
      d.times[d.times.length - 1]
    )}`;

  $('#show-cache').disabled = !d.isDefault;

  $('#show-cache').title = d.isDefault
    ? ''
    : 'Resultados pré-calculados disponíveis apenas para o conjunto padrão';

  renderSeries();
  renderCorrelation();
}

function renderFeatures() {
  const target = $('#target').value;

  const old = new Set(
    $$('#features input:checked').map(x => x.value)
  );

  $('#features').replaceChildren();

  for (const c of state.data.cols) {
    if (c === target) continue;

    const label = document.createElement('label');
    const input = document.createElement('input');

    input.type = 'checkbox';
    input.value = c;
    input.checked = !old.size || old.has(c);

    input.addEventListener('change', () => {
      $('#feature-count').textContent =
        `${$$('#features input:checked').length} selecionadas`;
    });

    label.append(
      input,
      document.createTextNode(c)
    );

    $('#features').append(label);
  }

  $('#feature-count').textContent =
    `${$$('#features input:checked').length} selecionadas`;
}

/* =========================================================
   RESOLUÇÃO DO SISTEMA LINEAR
   ========================================================= */

function solve(A, b) {
  const n = b.length;

  for (let k = 0; k < n; k++) {
    let pivot = k;

    for (let r = k + 1; r < n; r++) {
      if (
        Math.abs(A[r * n + k]) >
        Math.abs(A[pivot * n + k])
      ) {
        pivot = r;
      }
    }

    if (
      Math.abs(A[pivot * n + k]) <
      1e-11
    ) {
      A[k * n + k] += 1e-8;
    }

    for (let c = k; c < n; c++) {
      const tmp = A[k * n + c];

      A[k * n + c] =
        A[pivot * n + c];

      A[pivot * n + c] = tmp;
    }

    const temp = b[k];
    b[k] = b[pivot];
    b[pivot] = temp;

    const div = A[k * n + k];

    if (!div) return null;

    for (let c = k; c < n; c++) {
      A[k * n + c] /= div;
    }

    b[k] /= div;

    for (let r = k + 1; r < n; r++) {
      const f = A[r * n + k];

      for (let c = k; c < n; c++) {
        A[r * n + c] -=
          f * A[k * n + c];
      }

      b[r] -= f * b[k];
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) {
      b[i] -=
        A[i * n + j] * b[j];
    }
  }

  return b;
}

/* =========================================================
   REGRESSÃO (Alinhada com o Python)
   ========================================================= */

function fit(
  origin,
  end,
  lag,
  features,
  target,
  weighted,
  targetAt = null
) {
  const read = (i, j) =>
    j === target && targetAt
      ? targetAt(i)
      : readValue(i, j);

  const p = features.length;
  const n = end - origin - lag;

  if (n < Math.max(10, p + 3)) {
    return null;
  }

  const dim = p + 1;
  const X_rows = [];
  const y_vals = [];
  let valid = 0;

  for (let i = origin; i < end - lag; i++) {
    const y = read(i + lag, target);
    if (!Number.isFinite(y)) continue;

    let ok = true;
    const row = [1]; // Intercepto

    for (let j = 0; j < p; j++) {
      const v = read(i, features[j]);
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      row.push(v);
    }

    if (!ok) continue;

    X_rows.push(row);
    y_vals.push(y);
    valid++;
  }

  if (valid < Math.max(10, p + 3)) {
    return null;
  }

  const numSamples = X_rows.length;
  const X = new Float64Array(numSamples * dim);
  const Y = new Float64Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    Y[i] = y_vals[i];
    for (let j = 0; j < dim; j++) {
      X[i * dim + j] = X_rows[i][j];
    }
  }

  let Xw = new Float64Array(X);
  let Yw = new Float64Array(Y);

  if (weighted) {
    for (let i = 0; i < numSamples; i++) {
      const w = numSamples > 1 ? i / (numSamples - 1) : 1;
      Yw[i] *= w;
      for (let j = 0; j < dim; j++) {
        Xw[i * dim + j] *= w;
      }
    }
  }

  const M = new Float64Array(dim * dim);
  const b = new Float64Array(dim);

  for (let i = 0; i < numSamples; i++) {
    for (let a = 0; a < dim; a++) {
      b[a] += X[i * dim + a] * Yw[i];
      for (let c = 0; c < dim; c++) {
        M[a * dim + c] += X[i * dim + a] * Xw[i * dim + c];
      }
    }
  }

  const coef = solve(M, b);

  if (!coef) return null;

  return idx => {
    const rowPred = [1];
    for (let j = 0; j < p; j++) {
      const v = read(idx, features[j]);
      if (!Number.isFinite(v)) {
        return NaN;
      }
      rowPred.push(v);
    }

    let yPred = 0;
    for (let j = 0; j < dim; j++) {
      yPred += rowPred[j] * coef[j];
    }

    return yPred;
  };
}

/* =========================================================
   VALIDAÇÃO
   ========================================================= */

function paramsValid(s) {
  const n = state.data.times.length;

  if (s.target < 0 || !s.features.length) {
    return 'Selecione um alvo e ao menos uma variável explicativa.';
  }

  if (s.features.length >= 30) {
    return 'Selecione menos de 30 variáveis explicativas.';
  }

  if (!s.model.startsWith('ar')) {
    if (
      !Number.isFinite(
        s.forecastStart
      ) ||
      !Number.isFinite(
        s.endDate
      )
    ) {
      return 'Escolha o início e o fim da previsão.';
    }

    const from = atOrAfter(
      s.forecastStart
    );

    const to = atOrAfter(
      s.endDate
    );

    if (from < 20) {
      return 'A previsão precisa começar após pelo menos 20 pontos para ajustar a regressão.';
    }

    if (to < from) {
      return 'O fim da previsão deve ser posterior ao início.';
    }

    if (to >= n) {
      return 'A data final precisa estar dentro do período dos dados.';
    }

    return null;
  }

  if (!Number.isFinite(s.start)) {
    return 'Escolha o início da janela de treino.';
  }

  if (
    !Number.isFinite(s.train) ||
    s.train <
      Math.max(
        20,
        s.features.length + 11
      )
  ) {
    return `O treino precisa ter pelo menos ${Math.max(
      20,
      s.features.length + 11
    )} pontos.`;
  }

  if (
    !Number.isFinite(s.horizon) ||
    s.horizon < 1 ||
    s.horizon > 72 ||
    !Number.isFinite(s.lag) ||
    s.lag < 1 ||
    s.lag > 72
  ) {
    return 'Defina horizonte e lag máximo entre 1 e 72 passos.';
  }

  if (
    !Number.isFinite(s.windows) ||
    s.windows < 1 ||
    s.windows > 100
  ) {
    return 'Use de 1 a 100 janelas seguintes.';
  }

  const start = atOrAfter(
    s.start
  );

  if (
    start +
      s.train +
      s.horizon *
        s.windows >
    n
  ) {
    return 'Não há pontos suficientes após o treino para todas as datas previstas.';
  }

  const fits =
    s.windows *
    Math.ceil(
      s.horizon / s.lag
    );

  if (fits > 1200) {
    return 'Essa seleção exige mais de 1.200 ajustes. Reduza horizonte, janelas ou aumente o lag máximo.';
  }

  return null;
}

/* =========================================================
   PREVISÃO
   ========================================================= */

async function forecastRows(
  s,
  progress = () => {},
  cancel = () => false
) {
  const t = state.data.times;

  const isAR =
    s.model.startsWith('ar');

  const weighted =
    s.model.endsWith('w');

  const out = [];

  const predictedTarget =
    new Map();

  /* REGRESSÃO LINEAR */
  if (!isAR) {
    const from = atOrAfter(
      s.forecastStart
    );

    const end =
      atOrAfter(s.endDate) + 1;

    const usable = s.features.filter(j => {
      let ok = 0;

      for (let i = 0; i < from; i++) {
        if (
          Number.isFinite(readValue(i, j)) &&
          Number.isFinite(readValue(i, s.target))
        ) {
          ok++;
        }
      }

      return ok >= Math.max(10, s.features.length + 3);
    });

    const dropped =
      s.features.length - usable.length;

    if (!usable.length) {
      throw Error(
        'Nenhuma variável explicativa tem dados válidos antes do início da previsão. Escolha um início mais tarde.'
      );
    }

    const predict = fit(
      0,
      from,
      0,
      usable,
      s.target,
      weighted
    );

    if (!predict) {
      throw Error(
        'Não foi possível ajustar a regressão com as variáveis selecionadas.'
      );
    }

    state.note =
      dropped > 0
        ? ` ${dropped} variável(is) sem dados válidos no treino foram ignoradas.`
        : '';

    for (
      let idx = from;
      idx < end;
      idx++
    ) {
      if (cancel()) return null;

      const pred =
        predict(idx);

      const real =
        readValue(
          idx,
          s.target
        );

      if (
        Number.isFinite(pred) &&
        Number.isFinite(real)
      ) {
        out.push({
          idx,
          time: t[idx],
          real,
          pred,
          trainEnd: 0,
          window: 0,
          h: 0
        });
      }
    }

    return out;
  }

  /* AUTOREGRESSÃO */

  const start = atOrAfter(
    s.start
  );

  const initialEnd =
    start + s.train;

  const targetAt = i =>
    i < initialEnd
      ? readValue(
          i,
          s.target
        )
      : predictedTarget.has(i)
        ? predictedTarget.get(i)
        : NaN;

  for (
    let win = 0;
    win < s.windows;
    win++
  ) {
    for (
      let offset = 0;
      offset < s.horizon;
      offset += s.lag
    ) {
      if (cancel()) {
        return null;
      }

      const origin =
        initialEnd -
        1 +
        win * s.horizon +
        offset;

      const a =
        origin -
        s.train +
        1;

      const end =
        origin + 1;

      const block = Math.min(
        s.lag,
        s.horizon - offset
      );

      for (
        let h = 1;
        h <= block;
        h++
      ) {
        const predict = fit(
          a,
          end,
          h,
          s.features,
          s.target,
          weighted,
          targetAt
        );

        const idx =
          origin + h;

        if (!predict) {
          throw Error(
            `Sem ajuste válido para o lag ${h} na janela ${
              win + 1
            }.`
          );
        }

        const pred =
          predict(origin);

        const real =
          readValue(
            idx,
            s.target
          );

        if (!Number.isFinite(pred)) {
          throw Error(
            `Previsão inválida no passo ${
              idx - initialEnd + 1
            }.`
          );
        }

        predictedTarget.set(
          idx,
          pred
        );

        if (
          Number.isFinite(real)
        ) {
          out.push({
            idx,
            time: t[idx],
            real,
            pred,
            trainEnd: origin,
            window: win,
            h
          });
        }
      }
    }

    progress(
      win + 1,
      s.windows
    );

    if (
      (win + 1) % 2 ===
      0
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            0
          )
      );
    }
  }

  return out;
}

/* =========================================================
   CÁLCULO
   ========================================================= */

async function calculate() {
  const token =
    ++state.calcToken;

  try {
    const s =
      getSettings();

    const err =
      paramsValid(s);

    if (err) {
      status(err);
      return;
    }

    $('#run').disabled =
      true;

    status(
      'Calculando janelas móveis…'
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          0
        )
    );

    const out =
      await forecastRows(
        s,
        (done, total) => {
          if (
            token ===
            state.calcToken
          ) {
            status(
              `Calculando ${done} de ${total} janelas…`
            );
          }
        },
        () =>
          token !==
          state.calcToken
      );

    if (!out) return;

    state.pred = out;
    state.settings = s;
    state.reveal = out.length;

    drawForecast();

    status(
      out.length
        ? `${out.length.toLocaleString(
            'pt-BR'
          )} previsões calculadas em datas consecutivas.${
            s.model.startsWith('ar') ? '' : state.note || ''
          }`
        : 'Nenhuma previsão válida nesta seleção.'
    );
  } catch (e) {
    console.error('Erro no cálculo:', e);

    if (
      token ===
      state.calcToken
    ) {
      status(
        'Erro no cálculo: ' +
          e.message
      );
    }
  } finally {
    if (
      token ===
      state.calcToken
    ) {
      $('#run').disabled =
        false;
    }
  }
}

/* =========================================================
   MÉTRICAS
   ========================================================= */

function scores(rows) {
  const n = rows.length;

  if (!n) {
    return {
      mae: NaN,
      rmse: NaN,
      r2: NaN
    };
  }

  let mae = 0;
  let mse = 0;

  const mean =
    rows.reduce(
      (a, r) =>
        a + r.real,
      0
    ) / n;

  for (const r of rows) {
    const e =
      r.real - r.pred;

    mae += Math.abs(e);
    mse += e * e;
  }

  const sst =
    rows.reduce(
      (a, r) =>
        a +
        (r.real - mean) **
          2,
      0
    );

  return {
    mae: mae / n,
    rmse: Math.sqrt(
      mse / n
    ),
    r2:
      sst > 0
        ? 1 - (mse / sst) // Removido o Math.abs para refletir o R² real
        : NaN
  };
}

/* =========================================================
   GRÁFICO DE PREVISÃO
   ========================================================= */

function drawForecast() {
  const s =
    state.settings;

  if (!s) return;

  const rows =
    state.pred.slice(
      0,
      state.reveal
    );

  const q =
    scores(rows);

  const names = {
    arw: 'Autorregressão ponderada',
    ar: 'Autorregressão',
    linear: 'Regressão linear',
    linearw:
      'Regressão linear ponderada'
  };

  $('#mae').textContent =
    fmt(q.mae);

  $('#rmse').textContent =
    fmt(q.rmse);

  $('#r2').textContent =
    fmt(q.r2, 3);

  $('#count').textContent =
    rows.length.toLocaleString(
      'pt-BR'
    );

  $('#chart-title').textContent =
    `${names[s.model]} · ${
      state.data.cols[s.target]
    }`;

  $('#forecast-desc').textContent =
    s.model.startsWith('ar')
      ? `${dateFmt(
          state.data.times[
            atOrAfter(s.start)
          ]
        )} · treino de ${s.train.toLocaleString(
          'pt-BR'
        )} pontos · ${s.windows} janelas de ${s.horizon} passos`
      : `Série prevista com regressão ajustada até ${dateFmt(
          rows[
            rows.length - 1
          ]?.time ||
            s.endDate
        )}.`;

  const a =
    s.model.startsWith('ar')
      ? atOrAfter(s.start)
      : 0;

  const end =
    s.model.startsWith('ar')
      ? a + s.train
      : rows.length;

  const context =
    Math.min(
      80,
      s.train || 0
    );

  const train = [];

  if (
    s.model.startsWith('ar')
  ) {
    for (
      let i = Math.max(
        a,
        end - context
      );
      i < end;
      i++
    ) {
      train.push({
        time:
          state.data.times[i],
        value:
          readValue(
            i,
            s.target
          )
      });
    }
  }

  let plotRows = rows;

  if (rows.length > 1500) {
    const step =
      Math.ceil(
        rows.length /
          1500
      );

    plotRows =
      rows.filter(
        (_, i) =>
          i % step === 0
      );
  }

  plot(
    $('#forecast-chart'),
    {
      series: [
        ...(s.model.startsWith('ar')
          ? [
              {
                name: 'Treino',
                color:
                  '#00a1c9',
                dash: [5, 5],
                points: train
              }
            ]
          : []),
        {
          name: 'Real',
          color: '#dce7f3',
          points:
            plotRows.map(
              r => ({
                time: r.time,
                value: r.real
              })
            )
        },
        {
          name: 'Previsto',
          color: '#ff9900',
          points:
            plotRows.map(
              r => ({
                time: r.time,
                value: r.pred
              })
            )
        }
      ],
      tip: '#forecast-tip',
      dots: rows.length < 90
    }
  );

  if (rows.length) {
    $('#window-label').textContent =
      s.model.startsWith('ar')
        ? `Treino: ${dateFmt(
            state.data.times[a]
          )} → ${dateFmt(
            state.data.times[
              end - 1
            ]
          )}`
        : `Período exibido: ${dateFmt(
            rows[0].time
          )} → ${dateFmt(
            rows[
              rows.length - 1
            ].time
          )}`;

    $('#prediction-note').textContent =
      s.model.startsWith('ar')
        ? `Lags 1–${Math.min(
            s.lag,
            s.horizon
          )} · alvo previsto realimentado`
        : `Ajuste com dados anteriores ao início · ${dateFmt(
            rows[0].time
          )} até ${dateFmt(
            rows[
              rows.length - 1
            ].time
          )}`;
  }

  $('#method-note').textContent =
    s.model.startsWith('ar')
      ? 'Ajusta Y(t + h) para cada h de 1 até o lag máximo. Após cada bloco, a previsão do alvo passa a ser Y(t) na nova origem e entra no treino móvel. Os outros sensores da nova origem são os valores observados no CSV.'
      : 'Ajusta a regressão no conjunto completo disponível até a data escolhida e calcula a série prevista com os sensores observados em cada data. Não usa treino, horizonte, lag ou janelas.';
}

/* =========================================================
   GRÁFICOS CANVAS
   ========================================================= */

function plot(
  canvas,
  {
    series,
    tip,
    dots = false,
    normalize = false
  }
) {
  if (!canvas) return;

  const rect =
    canvas.getBoundingClientRect();

  const W =
    Math.max(
      200,
      rect.width
    );

  const H =
    Math.max(
      150,
      rect.height
    );

  const dpr =
    window.devicePixelRatio ||
    1;

  canvas.width =
    W * dpr;

  canvas.height =
    H * dpr;

  const ctx =
    canvas.getContext('2d');

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  const all =
    series
      .flatMap(
        s => s.points
      )
      .filter(
        p =>
          Number.isFinite(
            p.value
          ) &&
          Number.isFinite(
            p.time
          )
      );

  ctx.fillStyle =
    '#121f32';

  ctx.fillRect(
    0,
    0,
    W,
    H
  );

  if (!all.length) {
    return;
  }

  const left = 62;
  const right = 18;
  const top = 20;
  const bottom = 34;

  const xmin =
    Math.min(
      ...all.map(
        p => p.time
      )
    );

  let xmax =
    Math.max(
      ...all.map(
        p => p.time
      )
    );

  if (xmin === xmax) {
    xmax =
      xmin + 600000;
  }

  let ymin = normalize
    ? 0
    : Math.min(
        ...all.map(
          p => p.value
        )
      );

  let ymax = normalize
    ? 1
    : Math.max(
        ...all.map(
          p => p.value
        )
      );

  if (ymin === ymax) {
    ymin -= 1;
    ymax += 1;
  }

  const pad =
    (ymax - ymin) *
    0.07;

  ymin -= pad;
  ymax += pad;

  const x = t =>
    left +
    ((t - xmin) /
      (xmax - xmin)) *
      (W - left - right);

  const y = v =>
    H -
    bottom -
    ((v - ymin) /
      (ymax - ymin)) *
      (H - top - bottom);

  ctx.font =
    '12px system-ui';

  ctx.lineWidth = 1;

  for (
    let i = 0;
    i <= 4;
    i++
  ) {
    const yy =
      top +
      (i *
        (H - top - bottom)) /
        4;

    ctx.strokeStyle =
      '#293e55';

    ctx.beginPath();

    ctx.moveTo(
      left,
      yy
    );

    ctx.lineTo(
      W - right,
      yy
    );

    ctx.stroke();

    ctx.fillStyle =
      '#8ea4ba';

    ctx.textAlign =
      'right';

    ctx.fillText(
      fmt(
        ymax -
          (i *
            (ymax - ymin)) /
            4,
        2
      ),
      left - 9,
      yy + 4
    );
  }

  for (
    let i = 0;
    i <= 4;
    i++
  ) {
    const xx =
      left +
      (i *
        (W - left - right)) /
        4;

    ctx.fillStyle =
      '#8ea4ba';

    ctx.textAlign =
      i === 0
        ? 'left'
        : i === 4
          ? 'right'
          : 'center';

    ctx.fillText(
      new Date(
        xmin +
          (i *
            (xmax - xmin)) /
            4
      ).toLocaleDateString(
        'pt-BR',
        {
          day: '2-digit',
          month: 'short',
          year: '2-digit',
          timeZone: 'UTC'
        }
      ),
      xx,
      H - 9
    );
  }

  for (const s of series) {
    ctx.beginPath();

    ctx.strokeStyle =
      s.color;

    ctx.lineWidth =
      s.name === 'Previsto'
        ? 2.4
        : 1.8;

    ctx.setLineDash(
      s.dash || []
    );

    let pen = false;

    for (const p of s.points) {
      if (
        !Number.isFinite(
          p.value
        ) ||
        !Number.isFinite(
          p.time
        )
      ) {
        pen = false;
        continue;
      }

      const xx =
        x(p.time);

      const yy =
        y(p.value);

      if (!pen) {
        ctx.moveTo(
          xx,
          yy
        );

        pen = true;
      } else {
        ctx.lineTo(
          xx,
          yy
        );
      }
    }

    ctx.stroke();

    ctx.setLineDash([]);

    if (dots) {
      for (const p of s.points) {
        if (
          !Number.isFinite(
            p.value
          ) ||
          !Number.isFinite(
            p.time
          )
        ) {
          continue;
        }

        ctx.fillStyle =
          s.color;

        ctx.beginPath();

        ctx.arc(
          x(p.time),
          y(p.value),
          2.5,
          0,
          Math.PI * 2
        );

        ctx.fill();
      }
    }
  }

  canvas.onmousemove =
    e => {
      let near = null;
      let best = Infinity;

      for (const s of series) {
        for (const p of s.points) {
          if (
            !Number.isFinite(
              p.value
            ) ||
            !Number.isFinite(
              p.time
            )
          ) {
            continue;
          }

          const dist =
            Math.abs(
              x(p.time) -
                e.offsetX
            );

          if (dist < best) {
            near = {
              ...p,
              name: s.name
            };

            best = dist;
          }
        }
      }

      const el = $(tip);

      if (
        near &&
        best < 24
      ) {
        el.hidden = false;

        el.style.left =
          Math.min(
            W - 155,
            e.offsetX + 12
          ) + 'px';

        el.style.top =
          Math.max(
            0,
            e.offsetY - 45
          ) + 'px';

        el.textContent =
          `${dateFmt(
            near.time
          )} · ${near.name}: ${fmt(
            near.value
          )}`;
      } else {
        el.hidden = true;
      }
    };

  canvas.onmouseleave =
    () => {
      const el = $(tip);
      if (el) el.hidden = true;
    };
}

/* =========================================================
   SÉRIE TEMPORAL
   ========================================================= */

function renderSeries() {
  if (!state.data) return;

  const d =
    state.data;

  const target =
    d.cols.indexOf(
      $('#target').value
    );

  const extra =
    d.cols.indexOf(
      $('#series-extra').value
    );

  const n =
    d.times.length;

  const step =
    Math.max(
      1,
      Math.ceil(
        n / 1600
      )
    );

  const colA =
    getCol(target);

  const colB =
    extra >= 0 &&
    extra !== target
      ? getCol(extra)
      : null;

  const normalized =
    !!colB;

  const norm = a => {
    let min = Infinity;
    let max = -Infinity;

    for (const v of a) {
      if (
        Number.isFinite(v)
      ) {
        min = Math.min(
          min,
          v
        );

        max = Math.max(
          max,
          v
        );
      }
    }

    return v =>
      (v - min) /
      (max - min || 1);
  };

  const na =
    normalized
      ? norm(colA)
      : v => v;

  const nb =
    colB
      ? norm(colB)
      : null;

  const points = fn => {
    const r = [];

    for (
      let i = 0;
      i < n;
      i += step
    ) {
      r.push({
        time:
          d.times[i],
        value: fn(i)
      });
    }

    return r;
  };

  $('#series-title').textContent =
    d.cols[target] +
    (colB
      ? ' + ' +
        d.cols[extra]
      : '');

  plot(
    $('#series-chart'),
    {
      series: [
        {
          name:
            short(
              d.cols[target]
            ),
          color:
            '#ff9900',
          points:
            points(
              i =>
                na(
                  colA[i]
                )
            )
        },
        ...(colB
          ? [
              {
                name:
                  short(
                    d.cols[
                      extra
                    ]
                  ),
                color:
                  '#00a1c9',
                points:
                  points(
                    i =>
                      nb(
                        colB[i]
                      )
                  )
              }
            ]
          : [])
      ],
      tip: '#series-tip',
      normalize:
        normalized
    }
  );
}

/* =========================================================
   CORRELAÇÃO
   ========================================================= */

function corrWindows() {
  const t =
    state.data.times;

  const first =
    t[0];

  const span =
    30 *
    86400000;

  const last =
    t[t.length - 1];

  return Math.max(
    1,
    Math.ceil(
      (last - first + 1) /
        span
    )
  );
}

function corrAt(k) {
  if (
    state.corrMatrices.has(k)
  ) {
    return state.corrMatrices.get(
      k
    );
  }

  const d =
    state.data;

  const n =
    d.cols.length;

  const from =
    d.times[0] +
    k *
      30 *
      86400000;

  const to =
    from +
    30 *
      86400000;

  const begin =
    atOrAfter(from);

  const end =
    atOrAfter(to);

  const sums =
    new Float64Array(n);

  const products =
    new Float64Array(
      n * n
    );

  const squares =
    new Float64Array(n);

  const counts =
    new Float64Array(
      n * n
    );

  for (
    let i = begin;
    i < end;
    i++
  ) {
    for (
      let j = 0;
      j < n;
      j++
    ) {
      const v =
        readValue(
          i,
          j
        );

      if (
        Number.isFinite(v)
      ) {
        sums[j] += v;
        squares[j] +=
          v * v;
      }
    }

    for (
      let a = 0;
      a < n;
      a++
    ) {
      const va =
        readValue(
          i,
          a
        );

      if (
        !Number.isFinite(
          va
        )
      ) {
        continue;
      }

      for (
        let b = 0;
        b <= a;
        b++
      ) {
        const vb =
          readValue(
            i,
            b
          );

        if (
          Number.isFinite(
            vb
          )
        ) {
          products[
            a * n + b
          ] +=
            va * vb;

          counts[
            a * n + b
          ]++;
        }
      }
    }
  }

  const N =
    end - begin;

  const matrix =
    new Float64Array(
      n * n
    );

  for (
    let a = 0;
    a < n;
    a++
  ) {
    for (
      let b = 0;
      b <= a;
      b++
    ) {
      const varianceA =
        Math.max(
          0,
          squares[a] -
            (sums[a] *
              sums[a]) /
              N
        );

      const varianceB =
        Math.max(
          0,
          squares[b] -
            (sums[b] *
              sums[b]) /
              N
        );

      const den =
        Math.sqrt(
          varianceA *
            varianceB
        );

      const v =
        N > 2 &&
        counts[
          a * n + b
        ] === N &&
        den > 0
          ? (
              products[
                a * n + b
              ] -
              (sums[a] *
                sums[b]) /
                N
            ) / den
          : NaN;

      matrix[
        a * n + b
      ] =
        matrix[
          b * n + a
        ] =
          Number.isFinite(v)
            ? Math.max(
                -1,
                Math.min(
                  1,
                  v
                )
              )
            : NaN;
    }
  }

  const result = {
    matrix,
    begin,
    end
  };

  state.corrMatrices.set(
    k,
    result
  );

  return result;
}

function corrColor(v) {
  if (
    !Number.isFinite(v)
  ) {
    return '#304052';
  }

  const s =
    Math.abs(v);

  const h =
    v < 0
      ? 195
      : 32;

  return `hsl(${h} ${
    20 + s * 55
  }% ${
    22 + s * 34
  }%)`;
}

function renderCorrelation() {
  if (!state.data) return;

  const max =
    corrWindows() - 1;

  $('#corr-slider').max =
    max;

  state.corrIndex =
    Math.min(
      max,
      Math.max(
        0,
        state.corrIndex
      )
    );

  $('#corr-slider').value =
    state.corrIndex;

  const k =
    state.corrIndex;

  const d =
    state.data;

  const n =
    d.cols.length;

  const r =
    corrAt(k);

  const start =
    d.times[0] +
    k *
      30 *
      86400000;

  const end =
    Math.min(
      d.times[
        d.times.length - 1
      ],
      start +
        30 *
          86400000 -
        1
    );

  const target =
    d.cols.indexOf(
      $('#target').value
    );

  $('#corr-period').textContent =
    `Janela ${k + 1} / ${
      max + 1
    }`;

  $('#corr-title').textContent =
    `Correlação · janela ${
      k + 1
    }`;

  $('#corr-subtitle').textContent =
    `${dateFmt(
      start
    )} — ${dateFmt(
      end
    )}`;

  $('#corr-points').textContent =
    `${(
      r.end - r.begin
    ).toLocaleString(
      'pt-BR'
    )} medições`;

  const box =
    $('#heatmap');

  box.replaceChildren();

  box.style.gridTemplateColumns =
    `100px repeat(${n}, minmax(38px, 1fr))`;

  const corner =
    document.createElement(
      'span'
    );

  box.append(corner);

  for (const c of d.cols) {
    const el =
      document.createElement(
        'div'
      );

    el.className =
      'heat-head vertical';

    el.textContent =
      short(c);

    el.title = c;

    box.append(el);
  }

  for (
    let a = 0;
    a < n;
    a++
  ) {
    const head =
      document.createElement(
        'div'
      );

    head.className =
      'heat-row';

    head.textContent =
      short(d.cols[a]);

    head.title =
      d.cols[a];

    box.append(head);

    for (
      let b = 0;
      b < n;
      b++
    ) {
      const v =
        r.matrix[
          a * n + b
        ];

      const el =
        document.createElement(
          'div'
        );

      el.className =
        'heat-cell';

      el.style.background =
        corrColor(v);

      el.textContent =
        Number.isFinite(v)
          ? v.toFixed(2)
          : '—';

      el.title =
        `${d.cols[a]} × ${
          d.cols[b]
        } · r = ${fmt(
          v,
          3
        )}`;

      box.append(el);
    }
  }

  const entries =
    d.cols
      .map(
        (c, j) => ({
          c,
          v: r.matrix[
            target * n + j
          ]
        })
      )
      .filter(
        (_, j) =>
          j !== target
      )
      .sort(
        (a, b) =>
          Math.abs(
            b.v || 0
          ) -
          Math.abs(
            a.v || 0
          )
      );

  const dst =
    $('#corr-target');

  dst.replaceChildren();

  for (const item of entries) {
    const el =
      document.createElement(
        'div'
      );

    el.className =
      'corr-item';

    const label =
      document.createElement(
        'small'
      );

    const bar =
      document.createElement(
        'span'
      );

    const fill =
      document.createElement(
        'b'
      );

    const num =
      document.createElement(
        'em'
      );

    label.textContent =
      item.c;

    label.title =
      item.c;

    fill.style.width =
      `${
        Number.isFinite(
          item.v
        )
          ? Math.abs(
              item.v
            ) * 100
          : 0
      }%`;

    fill.style.background =
      item.v < 0
        ? '#268fb2'
        : '#f0a13d';

    bar.append(fill);

    num.textContent =
      `r = ${fmt(
        item.v,
        3
      )}`;

    el.append(
      label,
      bar,
      num
    );

    dst.append(el);
  }
}

/* =========================================================
   CACHE
   ========================================================= */

async function loadCache() {
  if (state.cache) {
    return state.cache;
  }

  const r =
    await fetch(
      'assets/cached-weighted-ar.f32'
    );

  if (!r.ok) {
    throw Error(
      'Arquivo de resultados indisponível'
    );
  }

  state.cache =
    new Float32Array(
      await r.arrayBuffer()
    );

  return state.cache;
}

function drawCache() {
  const d =
    state.data;

  const lag =
    Math.floor(
      +$('#cache-lag').value
    );

  const from =
    Date.parse(
      $('#cache-from').value +
        'T00:00:00Z'
    );

  const to =
    Date.parse(
      $('#cache-to').value +
        'T23:59:59Z'
    );

  if (
    lag < 1 ||
    lag > 12 ||
    !Number.isFinite(
      from
    ) ||
    !Number.isFinite(
      to
    ) ||
    from > to
  ) {
    $('#cache-note').textContent =
      'Selecione lag máximo de 1 a 12 e um período válido.';

    return;
  }

  const a =
    atOrAfter(from);

  const b =
    atOrAfter(to + 1);

  const target =
    d.cols.indexOf(
      state.meta.defaultTarget
    );

  const rows = [];

  for (
    let origin =
      Math.max(
        4319,
        a - 1
      );
    origin < b - 1;
    origin += lag
  ) {
    const train =
      origin - 4319;

    if (
      train < 0 ||
      train * 12 >=
        state.cache.length
    ) {
      break;
    }

    for (
      let h = 1;
      h <= lag &&
      origin + h < b;
      h++
    ) {
      const idx =
        origin + h;

      const p =
        state.cache[
          train * 12 +
            h - 1
        ];

      const real =
        readValue(
          idx,
          target
        );

      if (
        Number.isFinite(p) &&
        Number.isFinite(real)
      ) {
        rows.push({
          time:
            d.times[idx],
          pred: p,
          real
        });
      }
    }
  }

  state.cacheRows =
    rows;

  const step =
    Math.max(
      1,
      Math.ceil(
        rows.length /
          1700
      )
    );

  const display =
    rows.filter(
      (_, i) =>
        i % step === 0 ||
        i ===
          rows.length - 1
    );

  plot(
    $('#cache-chart'),
    {
      series: [
        {
          name: 'Real',
          color:
            '#dce7f3',
          points:
            display.map(
              r => ({
                time: r.time,
                value:
                  r.real
              })
            )
        },
        {
          name: 'Previsto',
          color:
            '#ff9900',
          points:
            display.map(
              r => ({
                time: r.time,
                value:
                  r.pred
              })
            )
        }
      ],
      tip: '#cache-tip'
    }
  );

  const q =
    scores(rows);

  $('#cache-note').textContent =
    `${rows.length.toLocaleString(
      'pt-BR'
    )} previsões em datas únicas (${display.length.toLocaleString(
      'pt-BR'
    )} pontos desenhados) · MAE ${fmt(
      q.mae
    )} · RMSE ${fmt(
      q.rmse
    )} · R² ${fmt(
      q.r2,
      3
    )}. Métricas calculadas em todas as previsões.`;
}

/* =========================================================
   DOWNLOAD
   ========================================================= */

function downloadRows() {
  const rows =
    state.pred;

  if (!rows.length) return;

  const csv =
    'data_predicao,janela,lag_ou_horizonte,Y_real,Y_pred\n' +
    rows
      .map(r =>
        [
          new Date(
            r.time
          ).toISOString(),
          r.window,
          r.h ||
            state.settings
              .lag,
          r.real,
          r.pred
        ].join(',')
      )
      .join('\n');

  const url =
    URL.createObjectURL(
      new Blob(
        [csv],
        {
          type:
            'text/csv;charset=utf-8'
        }
      )
    );

  const a =
    document.createElement(
      'a'
    );

  a.href = url;
  a.download =
    'previsoes_dashboard.csv';

  a.click();

  setTimeout(
    () =>
      URL.revokeObjectURL(
        url
      ),
    1000
  );
}

/* =========================================================
   ANIMAÇÃO
   ========================================================= */

function animateForecast() {
  if (state.animation) {
    clearInterval(
      state.animation
    );

    state.animation =
      null;

    $('#play').textContent =
      '▶ Animar';

    return;
  }

  if (!state.pred.length) {
    return;
  }

  state.reveal = 1;

  $('#play').textContent =
    '■ Parar';

  drawForecast();

  state.animation =
    setInterval(() => {
      state.reveal =
        Math.min(
          state.pred.length,
          state.reveal +
            Math.max(
              1,
              Math.ceil(
                state.pred.length /
                  60
              )
            )
        );

      drawForecast();

      if (
        state.reveal >=
        state.pred.length
      ) {
        clearInterval(
          state.animation
        );

        state.animation =
          null;

        $('#play').textContent =
          '▶ Animar';
      }
    }, 65);
}

/* =========================================================
   UPLOAD CSV
   ========================================================= */

async function uploadCSV(file) {
  const box =
    $('#upload-status');

  box.textContent =
    'Lendo CSV…';

  try {
    const text =
      await file.text();

    const lines =
      text
        .trim()
        .split(/\r?\n/);

    if (!lines.length) {
      throw Error(
        'Arquivo vazio.'
      );
    }

    const sep =
      lines[0].includes(';')
        ? ';'
        : ',';

    const headers =
      lines[0]
        .replace(
          /^\uFEFF/,
          ''
        )
        .split(sep)
        .map(
          s =>
            s
              .trim()
              .replace(
                /^"|"$/g,
                ''
              )
        );

    let timeCol =
      headers.findIndex(
        s =>
          /^(date[-_ ]?time|data[-_ ]?hora|timestamp|datetime|data)$/i.test(
            s
          )
      );

    if (timeCol < 0) {
      timeCol = 0;
    }

    const cols =
      headers.filter(
        (_, i) =>
          i !== timeCol
      );

    const records = [];

    for (
      let l = 1;
      l < lines.length;
      l++
    ) {
      const cells =
        lines[l].split(
          sep
        );

      if (
        cells.length !==
        headers.length
      ) {
        continue;
      }

      const raw =
        cells[timeCol]
          .replace(
            /^"|"$/g,
            ''
          );

      const ms =
        parseDate(raw);

      if (
        !Number.isFinite(ms)
      ) {
        continue;
      }

      const vals =
        cols.map(
          (_, j) => {
            const k =
              j < timeCol
                ? j
                : j + 1;

            const v =
              cells[k]
                .replace(
                  /^"|"$/g,
                  ''
                )
                .trim();

            return Number(
              v.replace(
                ',',
                '.'
              )
            );
          }
        );

      if (
        vals.some(
          Number.isFinite
        )
      ) {
        records.push({
          ms,
          vals
        });
      }
    }

    if (
      records.length < 40
    ) {
      throw Error(
        'CSV precisa de pelo menos 40 linhas com data/hora e valores numéricos.'
      );
    }

    records.sort(
      (a, b) =>
        a.ms - b.ms
    );

    const values =
      new Float32Array(
        records.length *
          cols.length
      );

    const times =
      new Float64Array(
        records.length
      );

    records.forEach(
      (r, i) => {
        times[i] =
          r.ms;

        for (
          let j = 0;
          j < cols.length;
          j++
        ) {
          values[
            i * cols.length +
              j
          ] =
            r.vals[j];
        }
      }
    );

    state.data = {
      name: file.name,
      cols,
      times,
      values,
      isDefault: false
    };

    state.meta = {
      defaultTarget:
        cols[0],
      defaultTrain:
        Math.min(
          4320,
          Math.floor(
            records.length /
              3
          )
        )
    };

    state.pred = [];
    state.cache = null;

    $('#cache-controls').hidden =
      true;

    initControls();

    calculate();

    box.textContent =
      `${records.length.toLocaleString(
        'pt-BR'
      )} linhas carregadas.`;
  } catch (e) {
    box.textContent =
      'Não foi possível ler o arquivo: ' +
      e.message;
  }
}

/* =========================================================
   CARREGAMENTO DOS ARQUIVOS
   ========================================================= */

async function main() {
  try {
    status(
      'Carregando dados…'
    );

    const metaResponse =
      await fetch(
        'assets/meta.json',
        {
          cache: 'no-store'
        }
      );

    if (!metaResponse.ok) {
      throw Error(
        `meta.json não encontrado (${metaResponse.status})`
      );
    }

    const m =
      await metaResponse.json();

    const [
      valuesResponse,
      timesResponse
    ] = await Promise.all([
      fetch(
        'assets/values.f32',
        {
          cache: 'no-store'
        }
      ),
      fetch(
        'assets/times.i64',
        {
          cache: 'no-store'
        }
      )
    ]);

    if (
      !valuesResponse.ok
    ) {
      throw Error(
        `values.f32 não encontrado (${valuesResponse.status})`
      );
    }

    if (
      !timesResponse.ok
    ) {
      throw Error(
        `times.i64 não encontrado (${timesResponse.status})`
      );
    }

    const [
      v,
      t
    ] = await Promise.all([
      valuesResponse.arrayBuffer(),
      timesResponse.arrayBuffer()
    ]);

    state.meta = m;

    state.data = {
      name: 'df_total.csv',
      cols: m.columns,
      values:
        new Float32Array(v),
      times:
        Float64Array.from(
          new BigInt64Array(t),
          x => Number(x)
        ),
      isDefault: true
    };

    initControls();

    updateModelControls();

    await calculate();

    status(
      'Dados carregados.'
    );
  } catch (e) {
    console.error(e);

    status(
      'Falha ao carregar dados padrão: ' +
        e.message
    );
  }
}

/* =========================================================
   EVENTOS
   ========================================================= */

$$('.tab').forEach(
  b =>
    b.onclick = () => {
      $$('.tab').forEach(         t =>           t.classList.toggle(             'active',             t === b           )       );        $$
('.view').forEach(
        v =>
          v.classList.toggle(
            'active',
            v.id ===
              b.dataset.tab
          )
      );

      state.tab =
        b.dataset.tab;

      if (
        state.tab ===
        'series'
      ) {
        renderSeries();
      }

      if (
        state.tab ===
        'correlation'
      ) {
        renderCorrelation();
      }

      if (
        state.tab ===
        'forecast'
      ) {
        drawForecast();
      }
    }
);

$('#target').onchange =
  () => {
    renderFeatures();
    renderSeries();
    renderCorrelation();
    calculate();
  };

function updateModelControls() {
  const ar =
    $('#model').value.startsWith(
      'ar'
    );

  $('#ar-controls').hidden =
    !ar;

  $('#linear-controls').hidden =
    ar;

  $('#forecast-end').disabled =
    ar;
}

$('#model').onchange =
  () => {
    updateModelControls();
    calculate();
  };

$('#all-features').onclick =   () => {     $$('#features input').forEach(
      x =>
        (x.checked = true)
    );

    $('#feature-count').textContent =
      `${$$(
        '#features input:checked'
      ).length} selecionadas`;

    calculate();
  };

$('#no-features').onclick =   () => {     $$('#features input').forEach(
      x =>
        (x.checked = false)
    );

    $('#feature-count').textContent =
      '0 selecionadas';

    calculate();
  };

$('#series-extra').onchange =
  renderSeries;

$('#run').onclick =
  calculate;

$('#forecast-start').onchange =
  calculate;

$('#forecast-end').onchange =
  calculate;

$('#reset').onclick =
  () => {
    if (state.data) {
      initControls();

      $('#horizon').value =
        12;

      $('#lag').value =
        12;

      $('#windows').value =
        12;

      $('#model').value =
        'arw';

      updateModelControls();

      calculate();
    }
  };

$('#play').onclick =
  animateForecast;

$('#download').onclick =
  downloadRows;

$('#upload').onchange =
  e => {
    if (
      e.target.files[0]
    ) {
      uploadCSV(
        e.target.files[0]
      );
    }
  };

$('#corr-slider').oninput =
  e => {
    state.corrIndex =
      +e.target.value;

    renderCorrelation();
  };

$('#corr-prev').onclick =
  () => {
    state.corrIndex--;

    if (
      state.corrIndex < 0
    ) {
      state.corrIndex = 0;
    }

    renderCorrelation();
  };

$('#corr-next').onclick =
  () => {
    state.corrIndex++;

    const max =
      corrWindows() - 1;

    if (
      state.corrIndex >
      max
    ) {
      state.corrIndex =
        max;
    }

    renderCorrelation();
  };

$('#corr-play').onclick =
  () => {
    if (state.corrTimer) {
      clearInterval(
        state.corrTimer
      );

      state.corrTimer =
        null;

      $('#corr-play').textContent =
        '▶ Animar meses';
    } else {
      state.corrTimer =
        setInterval(() => {
          state.corrIndex =
            (state.corrIndex +
              1) %
            corrWindows();

          renderCorrelation();
        }, 1100);

      $('#corr-play').textContent =
        '■ Parar';
    }
  };

$('#show-cache').onclick =
  async () => {
    const el =
      $('#cache-controls');

    el.hidden =
      !el.hidden;

    if (!el.hidden) {
      $('#cache-note').textContent =
        'Carregando resultados…';

      try {
        await loadCache();
        drawCache();
      } catch (e) {
        $('#cache-note').textContent =
          e.message;
      }
    }
  };

$('#cache-apply').onclick =
  drawCache;

/* =========================================================
   REDIMENSIONAMENTO
   ========================================================= */

let timer;

window.onresize =
  () => {
    clearTimeout(timer);

    timer =
      setTimeout(() => {
        if (
          state.tab ===
          'forecast'
        ) {
          drawForecast();

          if (
            !$('#cache-controls')
              .hidden &&
            state.cache
          ) {
            drawCache();
          }
        }

        if (
          state.tab ===
          'series'
        ) {
          renderSeries();
        }

        if (
          state.tab ===
          'correlation'
        ) {
          renderCorrelation();
        }
      }, 160);
  };

/* =========================================================
   INICIALIZAÇÃO
   ========================================================= */

updateModelControls();

main();
