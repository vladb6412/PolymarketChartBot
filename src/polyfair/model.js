const YEAR_SECONDS = 365.25 * 24 * 60 * 60;
const MIN_T_YEARS = 1 / YEAR_SECONDS;
const SIGMA_FLOOR = 1e-6;
const UPDATE_INTERVAL_MS = 300;
const MISPRICING_THRESHOLD = 0.03;
const ALERT_THRESHOLD = 0.05;
const EWMA_LAMBDA = 0.94;
const STUDENT_T_NU = 7;
const GARCH_DEFAULTS = {
  omega: 1e-5,
  alpha: 0.1,
  beta: 0.85
};

export const POLYFAIR_STRATEGIES = Object.freeze({
  LN_EWMA: "LN_EWMA",
  LN_GARCH: "LN_GARCH",
  T_EWMA: "T_EWMA"
});

export const POLYFAIR_DEFAULT_STRATEGY = POLYFAIR_STRATEGIES.LN_EWMA;

const DEFAULT_VOLATILITY = Object.freeze({
  "5m": 0.0008,
  "15m": 0.0015
});

export function buildPolyfairSpotDeltaSnapshot({ spotPrice, strikePrice }) {
  if (!Number.isFinite(spotPrice) || !Number.isFinite(strikePrice)) {
    return {
      spotDeltaUsd: null,
      spotDeltaAbsUsd: null,
      spotDeltaDirection: "unknown"
    };
  }

  const spotDeltaUsd = spotPrice - strikePrice;

  return {
    spotDeltaUsd,
    spotDeltaAbsUsd: Math.abs(spotDeltaUsd),
    spotDeltaDirection:
      spotDeltaUsd > 0 ? "up" : spotDeltaUsd < 0 ? "down" : "flat"
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function timeYears(seconds) {
  return Math.max(seconds / YEAR_SECONDS, MIN_T_YEARS);
}

function updateIntervalYears() {
  return (UPDATE_INTERVAL_MS / 1_000) / YEAR_SECONDS;
}

function gammaLn(value) {
  if (value < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * value)) - gammaLn(1 - value);
  }

  const coefficients = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-7,
    1.5056327351493116e-7
  ];
  let shifted = value - 1;
  let accumulator = coefficients[0];

  for (let index = 1; index < coefficients.length; index += 1) {
    accumulator += coefficients[index] / (shifted + index);
  }

  const temp = shifted + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(temp) -
    temp +
    Math.log(accumulator)
  );
}

function incompleteBeta(value, alpha, beta) {
  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  if (value > (alpha + 1) / (alpha + beta + 2)) {
    return 1 - incompleteBeta(1 - value, beta, alpha);
  }

  const betaFactor = Math.exp(
    alpha * Math.log(value) +
      beta * Math.log(1 - value) -
      gammaLn(alpha) -
      gammaLn(beta) +
      gammaLn(alpha + beta)
  ) / alpha;
  let term = 1;
  let continuedFraction = 1;
  let denominator = 1 - ((alpha + beta) * value) / (alpha + 1);

  if (Math.abs(denominator) < 1e-30) {
    denominator = 1e-30;
  }

  denominator = 1 / denominator;
  let result = denominator;

  for (let step = 1; step <= 200; step += 1) {
    let delta =
      (step * (beta - step) * value) / ((alpha + 2 * step - 1) * (alpha + 2 * step));
    denominator = 1 + delta * denominator;
    continuedFraction = 1 + delta / continuedFraction;
    denominator = 1 / (Math.abs(denominator) < 1e-30 ? 1e-30 : denominator);
    continuedFraction = Math.abs(continuedFraction) < 1e-30 ? 1e-30 : continuedFraction;
    result *= denominator * continuedFraction;

    delta =
      (-(alpha + step) * (alpha + beta + step) * value) /
      ((alpha + 2 * step) * (alpha + 2 * step + 1));
    denominator = 1 + delta * denominator;
    continuedFraction = 1 + delta / continuedFraction;
    denominator = 1 / (Math.abs(denominator) < 1e-30 ? 1e-30 : denominator);
    continuedFraction = Math.abs(continuedFraction) < 1e-30 ? 1e-30 : continuedFraction;
    const factor = denominator * continuedFraction;
    result *= factor;

    if (Math.abs(factor - 1) < 1e-10) {
      break;
    }
  }

  return betaFactor * result;
}

function normalCdf(value) {
  const alpha = 0.254829592;
  const beta = -0.284496736;
  const gamma = 1.421413741;
  const delta = -1.453152027;
  const epsilon = 1.061405429;
  const tau = 0.3275911;
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) / Math.SQRT2;
  const transformed = 1 / (1 + tau * scaled);
  const error =
    1 -
    (((((epsilon * transformed + delta) * transformed + gamma) * transformed + beta) *
      transformed +
      alpha) *
      transformed *
      Math.exp(-scaled * scaled));

  return 0.5 * (1 + sign * error);
}

function studentTCdf(value, degreesOfFreedom) {
  if (degreesOfFreedom <= 0) {
    return normalCdf(value);
  }

  const ratio =
    degreesOfFreedom / (degreesOfFreedom + value * value);
  const tail = incompleteBeta(ratio, degreesOfFreedom / 2, 0.5);
  return value >= 0 ? 1 - 0.5 * tail : 0.5 * tail;
}

function calibrateGarch(state) {
  const history = state.garch.history;

  if (history.length < 30) {
    return;
  }

  let variance = 0;
  for (const value of history) {
    variance += value * value;
  }
  variance /= history.length;

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestAlpha = state.garch.alpha;
  let bestBeta = state.garch.beta;

  for (let alpha = 0.02; alpha <= 0.2; alpha += 0.03) {
    for (let beta = 0.7; beta <= 0.96; beta += 0.04) {
      if (alpha + beta >= 0.999) {
        continue;
      }

      const omega = variance * (1 - alpha - beta);
      if (omega <= 0) {
        continue;
      }

      let sigma2 = variance;
      let score = 0;

      for (let index = 1; index < history.length; index += 1) {
        sigma2 = omega + alpha * history[index - 1] ** 2 + beta * sigma2;
        sigma2 = Math.max(sigma2, 1e-20);
        score += -0.5 * (Math.log(sigma2) + history[index] ** 2 / sigma2);
      }

      if (score > bestScore) {
        bestScore = score;
        bestAlpha = alpha;
        bestBeta = beta;
      }
    }
  }

  state.garch.alpha = bestAlpha;
  state.garch.beta = bestBeta;
  state.garch.omega = Math.max(variance * (1 - bestAlpha - bestBeta), 1e-10);
}

export function createPolyfairVolatilityState() {
  return {
    prevSpot: null,
    sigma2Delta: null,
    lambda: EWMA_LAMBDA,
    tickCount: 0,
    garch: {
      ...GARCH_DEFAULTS,
      sigma2_t: null,
      lastReturn: 0,
      history: []
    }
  };
}

export function updatePolyfairVolatilityState(state, spotPrice) {
  if (!state || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    return state;
  }

  if (state.prevSpot !== null && state.prevSpot > 0) {
    const logReturn = Math.log(spotPrice / state.prevSpot);

    state.sigma2Delta =
      state.sigma2Delta === null
        ? logReturn ** 2
        : state.lambda * state.sigma2Delta + (1 - state.lambda) * logReturn ** 2;

    const garch = state.garch;
    garch.sigma2_t =
      garch.sigma2_t === null
        ? logReturn ** 2
        : garch.omega +
          garch.alpha * garch.lastReturn ** 2 +
          garch.beta * garch.sigma2_t;
    garch.lastReturn = logReturn;
    garch.history.push(logReturn);

    if (garch.history.length > 500) {
      garch.history.shift();
    }

    const ticksPerMinute = Math.max(1, Math.floor(60_000 / UPDATE_INTERVAL_MS));
    if (garch.history.length >= 30 && state.tickCount % ticksPerMinute === 0) {
      calibrateGarch(state);
    }

    state.tickCount += 1;
  }

  state.prevSpot = spotPrice;
  return state;
}

function ewmaSigmaSquared(state, secondsRemaining) {
  if (state.sigma2Delta === null || state.sigma2Delta <= 0) {
    return DEFAULT_VOLATILITY["15m"] ** 2;
  }

  return state.sigma2Delta * (timeYears(secondsRemaining) / updateIntervalYears());
}

function garchSigmaSquared(state, secondsRemaining) {
  const garch = state.garch;

  if (garch.sigma2_t === null || garch.sigma2_t <= 0) {
    return DEFAULT_VOLATILITY["15m"] ** 2;
  }

  const steps = Math.min(
    Math.ceil(timeYears(secondsRemaining) / updateIntervalYears()),
    10_000
  );
  const persistence = garch.alpha + garch.beta;
  let aggregate = 0;
  let sigma2 =
    garch.omega + garch.alpha * garch.lastReturn ** 2 + garch.beta * garch.sigma2_t;

  aggregate += sigma2;

  for (let step = 2; step <= steps; step += 1) {
    sigma2 = garch.omega + persistence * sigma2;
    aggregate += sigma2;
  }

  return Math.max(aggregate, SIGMA_FLOOR ** 2);
}

export function getPolyfairDisplayedVolatility(state, timeframeKey) {
  if (state.sigma2Delta === null || state.sigma2Delta <= 0) {
    return DEFAULT_VOLATILITY[timeframeKey] ?? DEFAULT_VOLATILITY["15m"];
  }

  const horizonSeconds = timeframeKey === "5m" ? 300 : 900;
  return Math.sqrt(state.sigma2Delta * (timeYears(horizonSeconds) / updateIntervalYears()));
}

export function calculatePolyfairFairPrices({
  strategy = POLYFAIR_DEFAULT_STRATEGY,
  spotPrice,
  strikePrice,
  secondsRemaining,
  state
}) {
  if (!Number.isFinite(spotPrice) || !Number.isFinite(strikePrice) || spotPrice <= 0 || strikePrice <= 0) {
    return { fairUp: 0.5, fairDown: 0.5 };
  }

  const sigmaSquared =
    strategy === POLYFAIR_STRATEGIES.LN_GARCH
      ? garchSigmaSquared(state, secondsRemaining)
      : ewmaSigmaSquared(state, secondsRemaining);
  const variance = Math.max(sigmaSquared, SIGMA_FLOOR ** 2);
  const sigma = Math.sqrt(variance);
  let fairUp;

  if (strategy === POLYFAIR_STRATEGIES.T_EWMA) {
    const scaled = Math.log(strikePrice / spotPrice) / sigma;
    fairUp = 1 - studentTCdf(scaled, STUDENT_T_NU);
  } else {
    const normalized = (Math.log(spotPrice / strikePrice) - 0.5 * variance) / sigma;
    fairUp = normalCdf(normalized);
  }

  fairUp = clamp(fairUp, 0.01, 0.99);
  return {
    fairUp,
    fairDown: clamp(1 - fairUp, 0.01, 0.99)
  };
}

export function classifyPolyfairMispricing(diff) {
  if (!Number.isFinite(diff) || Math.abs(diff) < MISPRICING_THRESHOLD) {
    return "NEUTRAL";
  }

  return diff > 0 ? "UNDERVALUED" : "OVERPRICED";
}

export function hasPolyfairAlert(diff) {
  return Number.isFinite(diff) && Math.abs(diff) >= ALERT_THRESHOLD;
}

export function buildPolyfairRecommendation(strategySnapshot) {
  if (!strategySnapshot) {
    return {
      action: "NONE",
      tone: "neutral",
      text: "Waiting for Polyfair data"
    };
  }

  const { labelUp, labelDown, diffUp, diffDown } = strategySnapshot;
  const upAlert = hasPolyfairAlert(diffUp);
  const downAlert = hasPolyfairAlert(diffDown);

  if (upAlert || downAlert) {
    if (labelUp === "UNDERVALUED") {
      return { action: "BUY_UP", tone: "alert", text: "UP is undervalued - buy UP" };
    }

    if (labelUp === "OVERPRICED") {
      return { action: "BUY_DOWN", tone: "alert", text: "UP is overpriced - buy DOWN" };
    }

    if (labelDown === "UNDERVALUED") {
      return { action: "BUY_DOWN", tone: "alert", text: "DOWN is undervalued - buy DOWN" };
    }

    if (labelDown === "OVERPRICED") {
      return { action: "BUY_UP", tone: "alert", text: "DOWN is overpriced - buy UP" };
    }
  }

  if (labelUp === "UNDERVALUED") {
    return { action: "WATCH_UP", tone: "lean", text: "Slight UP undervalue" };
  }

  if (labelUp === "OVERPRICED") {
    return { action: "WATCH_DOWN", tone: "lean", text: "Slight UP overpricing" };
  }

  if (labelDown === "UNDERVALUED") {
    return { action: "WATCH_DOWN", tone: "lean", text: "Slight DOWN undervalue" };
  }

  if (labelDown === "OVERPRICED") {
    return { action: "WATCH_UP", tone: "lean", text: "Slight DOWN overpricing" };
  }

  return {
    action: "NONE",
    tone: "neutral",
    text: "Fair value - no edge"
  };
}

export function buildPolyfairStrategySnapshot({
  strategy,
  spotPrice,
  strikePrice,
  secondsRemaining,
  marketUpPrice,
  marketDownPrice,
  state
}) {
  const { fairUp, fairDown } = calculatePolyfairFairPrices({
    strategy,
    spotPrice,
    strikePrice,
    secondsRemaining,
    state
  });
  const diffUp =
    Number.isFinite(marketUpPrice) ? fairUp - marketUpPrice : null;
  const diffDown =
    Number.isFinite(marketDownPrice) ? fairDown - marketDownPrice : null;

  return {
    strategy,
    fairUp,
    fairDown,
    marketUp: Number.isFinite(marketUpPrice) ? marketUpPrice : null,
    marketDown: Number.isFinite(marketDownPrice) ? marketDownPrice : null,
    diffUp,
    diffDown,
    labelUp: classifyPolyfairMispricing(diffUp),
    labelDown: classifyPolyfairMispricing(diffDown),
    alertUp: hasPolyfairAlert(diffUp),
    alertDown: hasPolyfairAlert(diffDown)
  };
}
