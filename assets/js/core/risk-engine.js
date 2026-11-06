/* ==========================================================================
   数据驱动风险引擎（离线、确定性、可解释）
   依据手环连续体征时序（YL.data.vitalSeries）做：
     1. 描述统计：均值 / 最新值 / 极值 / 最小二乘趋势斜率；
     2. 阈值越界检测：与 store / processor 同一套阈值，逐天标注越界；
     3. 可解释风险：每个结论都引用具体数据点（数值 + 日期标签）；
     4. 个性化随访：按异常信号给出随访频次与具体事项。
   不发起任何网络请求，输入相同则输出恒定，便于离线双击演示与回归测试。
   ========================================================================== */
(function (global) {
  'use strict';

  var YL = global.YL;

  /* 阈值（与 store.DEFAULT_THRESHOLDS、iot/processor 保持一致） */
  var TH = { hrHigh: 105, hrLow: 50, spo2Low: 92, sbpHigh: 150 };
  /* 危急边界（与 processor critical 边界一致） */
  var CR = { hrHigh: 115, hrLow: 40, sbp: 180, spo2: 88 };

  /* 各指标的判定规则与展示文案 */
  var METRICS = {
    hr: {
      name: '心率', unit: 'bpm',
      isBreach: function (v) { return v > TH.hrHigh || v < TH.hrLow; },
      isCritical: function (v) { return v >= CR.hrHigh || v <= CR.hrLow; },
      isWorseTrend: function (s) { return Math.abs(s) >= 0.35; },
      thresholdText: '50–105 bpm'
    },
    sbp: {
      name: '收缩压', unit: 'mmHg',
      isBreach: function (v) { return v > TH.sbpHigh; },
      isCritical: function (v) { return v >= CR.sbp; },
      isWorseTrend: function (s) { return s >= 0.45; },
      thresholdText: '>150 mmHg'
    },
    spo2: {
      name: '血氧', unit: '%',
      isBreach: function (v) { return v < TH.spo2Low; },
      isCritical: function (v) { return v <= CR.spo2; },
      isWorseTrend: function (s) { return s <= -0.06; },
      thresholdText: '<92%'
    }
  };

  /* ---------------- 基础统计（纯函数） ---------------- */
  function avg(arr) {
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return arr.length ? sum / arr.length : 0;
  }

  /** 最小二乘斜率：返回每个序号（每天）的线性变化量 */
  function slope(arr) {
    var n = arr.length;
    if (n < 2) return 0;
    var xMean = (n - 1) / 2;
    var yMean = avg(arr);
    var num = 0, den = 0;
    for (var i = 0; i < n; i++) {
      num += (i - xMean) * (arr[i] - yMean);
      den += (i - xMean) * (i - xMean);
    }
    return den ? num / den : 0;
  }

  /** 取某数值首次出现位置对应的日期标签 */
  function labelAt(arr, labels, value) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === value) return labels[i];
    }
    return labels[arr.length - 1];
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /** 越界次数 → 基础分（饱和曲线）：重复越界显著抬升，而非按比例被稀释 */
  function breachBase(count) {
    if (count >= 10) return 75;
    if (count >= 6) return 60;
    if (count >= 3) return 45;
    if (count >= 1) return 20;
    return 0;
  }

  /* ---------------- 单指标分析 ---------------- */
  function analyzeMetric(key, values, labels) {
    var cfg = METRICS[key];
    var n = values.length;
    var latest = values[n - 1];
    var mean = avg(values);
    var mn = Math.min.apply(null, values);
    var mx = Math.max.apply(null, values);
    var sl = slope(values);

    var breachDays = [];
    for (var i = 0; i < n; i++) {
      if (cfg.isBreach(values[i])) breachDays.push({ label: labels[i], value: values[i] });
    }
    var breachCount = breachDays.length;
    var latestBreach = cfg.isBreach(latest);
    var criticalHit = values.some(function (v) { return cfg.isCritical(v); });
    var trendWorse = cfg.isWorseTrend(sl);

    /* 子分（0–100）：越界次数基础分 + 危急 18 + 最新越界 12 + 恶化趋势 8，全部来自真实数据 */
    var subScore = breachBase(breachCount) +
      (criticalHit ? 18 : 0) + (latestBreach ? 12 : 0) + (trendWorse ? 8 : 0);
    subScore = Math.min(100, Math.round(subScore));

    /* 级别 */
    var level = 'low';
    if (breachCount >= 5 || latestBreach || criticalHit) level = 'high';
    else if (breachCount >= 1 || trendWorse) level = 'mid';

    /* 可解释证据：每条都引用具体数据点与日期 */
    var evidence = [];
    if (key === 'hr') {
      evidence.push('最高 ' + mx + ' bpm（' + labelAt(values, labels, mx) +
        '）、最低 ' + mn + ' bpm（' + labelAt(values, labels, mn) + '）');
      evidence.push(breachCount ? '共 ' + breachCount + ' 天超出 ' + cfg.thresholdText :
        '近 ' + n + ' 天无越界，均值 ' + round1(mean) + ' bpm');
    } else if (key === 'sbp') {
      evidence.push('最高 ' + mx + ' mmHg（' + labelAt(values, labels, mx) + '），均值 ' + round1(mean));
      evidence.push(breachCount ? '共 ' + breachCount + ' 天收缩压 ' + cfg.thresholdText :
        '近 ' + n + ' 天血压均未越界');
    } else {
      evidence.push('最低 ' + mn + '%（' + labelAt(values, labels, mn) + '），均值 ' + round1(mean) + '%');
      evidence.push(breachCount ? '共 ' + breachCount + ' 天血氧 ' + cfg.thresholdText :
        '近 ' + n + ' 天血氧均在正常区间');
    }
    if (trendWorse) {
      var dir = key === 'spo2' ? (sl < 0 ? '下降' : '上升') :
        (key === 'sbp' ? (sl > 0 ? '上升' : '下降') : (sl > 0 ? '上升' : '下降'));
      evidence.push('整体呈' + dir + '趋势（约 ' + Math.abs(round1(sl)) + ' ' + cfg.unit + '/天）');
    }

    return {
      key: key, name: cfg.name, unit: cfg.unit,
      latest: latest, mean: round1(mean), min: mn, max: mx, slope: round1(sl),
      breachCount: breachCount, latestBreach: latestBreach, criticalHit: criticalHit,
      trendWorse: trendWorse, level: level, score: subScore, evidence: evidence
    };
  }

  /* ---------------- 随访计划（数据驱动） ---------------- */
  function buildFollowUp(level, metrics) {
    var frequency = level === 'high' ? '每周 1 次上门随访' :
      level === 'mid' ? '每两周 1 次上门随访' : '每月 1 次常规随访';

    var items = [];
    if (metrics.sbp.level !== 'low') items.push('复测血压，核对降压药服用与记录');
    if (metrics.spo2.level !== 'low') items.push('复测血氧，询问有无咳嗽、气促');
    if (metrics.hr.level !== 'low') items.push('复测心率，必要时协助预约心电图');
    if (metrics.hr.trendWorse || metrics.sbp.trendWorse || metrics.spo2.trendWorse) {
      items.push('复核近一周体征变化，确认异常是否持续');
    }
    items.push('检查手环佩戴与电量，排查居家跌倒隐患');
    return { frequency: frequency, items: items };
  }

  /* ---------------- 总入口 ---------------- */
  function build(elder, series, days) {
    var metrics = {
      hr: analyzeMetric('hr', series.hr, series.labels),
      sbp: analyzeMetric('sbp', series.sbp, series.labels),
      spo2: analyzeMetric('spo2', series.spo2, series.labels)
    };

    /* 加权均值（心率 0.3、血压 0.35、血氧 0.35）与最坏信号各占一半，
       避免单个危急信号被三指标平均稀释（临床分级由最突出发现驱动） */
    var weighted = metrics.hr.score * 0.3 + metrics.sbp.score * 0.35 + metrics.spo2.score * 0.35;
    var maxSub = Math.max(metrics.hr.score, metrics.sbp.score, metrics.spo2.score);
    var raw = Math.round(0.5 * maxSub + 0.5 * weighted);

    function isHigh(m) { return m.level === 'high'; }
    var highCount = [metrics.hr, metrics.sbp, metrics.spo2].filter(isHigh).length;
    var anyCritical = metrics.hr.criticalHit || metrics.sbp.criticalHit || metrics.spo2.criticalHit;
    var anyAbnormal = highCount > 0 ||
      metrics.hr.level === 'mid' || metrics.sbp.level === 'mid' || metrics.spo2.level === 'mid';

    /* 分级规则：危急且重复 / 两项以上高风险 / 原始分≥70 判高；存在任一异常判中；否则低 */
    var level = 'low';
    if ((anyCritical && highCount >= 1) || highCount >= 2 || raw >= 70) level = 'high';
    else if (anyAbnormal || raw >= 40) level = 'mid';

    /* 分数按分级区间校准，保证环上数字与颜色、结论一致 */
    var score;
    if (level === 'high') score = Math.min(95, Math.max(raw, 70));
    else if (level === 'mid') score = Math.min(69, Math.max(raw, 40));
    else score = Math.min(39, raw);

    /* 总体结论：点出最突出的异常信号 */
    var top = [metrics.sbp, metrics.spo2, metrics.hr].sort(function (a, b) { return b.score - a.score; })[0];
    var riskText = level === 'high' ? '偏高' : level === 'mid' ? '中等' : '较低';
    var topDesc = top.breachCount ? top.name + '存在 ' + top.breachCount + ' 天越界' :
      top.trendWorse ? top.name + '趋势异常' : '各项体征均在正常区间';
    var summary = '近 ' + days + ' 天' + topDesc + '，综合风险' + riskText + '。';

    var topEvidence = [];
    [metrics.sbp, metrics.spo2, metrics.hr].forEach(function (m) {
      topEvidence.push({ name: m.name, level: m.level, text: m.evidence[0] });
    });

    return {
      days: days,
      score: score,
      level: level,
      summary: summary,
      metrics: metrics,
      topEvidence: topEvidence,
      followUp: buildFollowUp(level, metrics)
    };
  }

  function analyze(elder, days) {
    var span = days || 30;
    var series = YL.data.vitalSeries(elder, span);
    return build(elder, series, span);
  }

  global.YL.riskEngine = {
    analyze: analyze,
    build: build,
    analyzeMetric: analyzeMetric,
    slope: slope,
    avg: avg
  };
})(window);
