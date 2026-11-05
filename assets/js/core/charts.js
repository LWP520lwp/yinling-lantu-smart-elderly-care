/* ==========================================================================
   ECharts 主题与图表工厂
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var echarts = global.echarts;

  var FONT = '"Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
  var NUM = 'Bahnschrift,"DIN Alternate","Segoe UI",sans-serif';

  var PALETTE = ['#165DFF', '#FF7D00', '#00B42A', '#00A6C0', '#D48806', '#8C9BB5'];
  var AXIS = '#E7EAF0';
  var TEXT_3 = '#86909C';
  var TEXT_2 = '#4E5969';

  var instances = [];

  function tooltip(extra) {
    return Object.assign({
      backgroundColor: '#FFFFFF',
      borderColor: '#E7EAF0',
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: '#1D2129', fontSize: 12, fontFamily: FONT },
      extraCssText: 'box-shadow:0 12px 32px -12px rgba(14,33,58,.28);border-radius:8px;'
    }, extra || {});
  }

  function baseGrid(o) {
    return Object.assign({ left: 6, right: 10, top: 26, bottom: 2, containLabel: true }, o || {});
  }

  function mount(dom, option) {
    if (!dom || !echarts) return null;
    var chart = echarts.init(dom, null, { renderer: 'canvas' });
    chart.setOption(option);
    instances.push(chart);
    return chart;
  }

  function disposeAll() {
    instances.forEach(function (c) {
      try { c.dispose(); } catch (e) { /* ignore */ }
    });
    instances = [];
  }

  function resizeAll() {
    instances.forEach(function (c) {
      try { c.resize(); } catch (e) { /* ignore */ }
    });
  }

  window.addEventListener('resize', U.debounce(resizeAll, 160));

  /* ------------------------------------------------------------------
     1. 环形图（健康分布 / 会员结构）
     ------------------------------------------------------------------ */
  function donutOption(data, colors, opts) {
    var o = opts || {};
    return {
      color: colors || PALETTE,
      tooltip: tooltip({
        trigger: 'item',
        formatter: function (p) {
          return p.marker + ' ' + p.name + '<br/><b style="font-family:' + NUM + ';font-size:14px">' +
            U.fmt(p.value) + '</b> 人 · ' + p.percent + '%';
        }
      }),
      legend: {
        show: o.legend !== false,
        bottom: 0,
        left: 'center',
        icon: 'circle',
        itemWidth: 7,
        itemHeight: 7,
        itemGap: 14,
        textStyle: { color: TEXT_2, fontSize: 11.5, fontFamily: FONT }
      },
      series: [{
        type: 'pie',
        radius: o.radius || ['58%', '80%'],
        center: o.center || ['50%', '44%'],
        avoidLabelOverlap: true,
        padAngle: 2,
        itemStyle: { borderWidth: 3, borderColor: '#fff', borderRadius: 4 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 5 },
        data: data
      }],
      animationDuration: 760,
      animationEasing: 'cubicOut'
    };
  }

  /* ------------------------------------------------------------------
     2. 设备状态柱状图
     ------------------------------------------------------------------ */
  function deviceBarOption(items) {
    return {
      tooltip: tooltip({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(22,93,255,.05)' } },
        formatter: function (ps) {
          var p = ps[0];
          return p.name + '：<b style="font-family:' + NUM + '">' + U.fmt(p.value) + '</b> 台';
        }
      }),
      grid: baseGrid({ top: 30, bottom: 0 }),
      xAxis: {
        type: 'category',
        data: items.map(function (i) { return i.name; }),
        axisLine: { lineStyle: { color: AXIS } },
        axisTick: { show: false },
        axisLabel: { color: TEXT_3, fontSize: 11.5, fontFamily: FONT, margin: 10 }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#F2F4F8', type: 'dashed' } },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM }
      },
      series: [{
        type: 'bar',
        barWidth: 30,
        data: items.map(function (i) {
          return { value: i.value, itemStyle: { color: i.color, borderRadius: [5, 5, 0, 0] } };
        }),
        label: {
          show: true,
          position: 'top',
          color: TEXT_2,
          fontSize: 12,
          fontFamily: NUM,
          fontWeight: 600,
          formatter: function (p) { return U.fmt(p.value); }
        }
      }],
      animationDuration: 800,
      animationDelay: function (idx) { return idx * 90; }
    };
  }

  /* ------------------------------------------------------------------
     3. 多维趋势折线（心率 / 血压 / 血氧）
     ------------------------------------------------------------------ */
  function vitalTrendOption(labels, series, opts) {
    var o = opts || {};
    var axisList = series.map(function (s, i) { return i === 2 ? 1 : 0; });
    return {
      color: series.map(function (s) { return s.color; }),
      tooltip: tooltip({ trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#C9D5E8', type: 'dashed' } } }),
      legend: {
        top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, itemGap: 14,
        textStyle: { color: TEXT_3, fontSize: 11, fontFamily: FONT }
      },
      grid: baseGrid({ top: 30, right: 34, bottom: 0, left: 4 }),
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLine: { lineStyle: { color: AXIS } },
        axisTick: { show: false },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, margin: 10 }
      },
      yAxis: [
        {
          type: 'value', name: o.leftName || '', nameTextStyle: { color: '#A9B0BC', fontSize: 10, padding: [0, 0, 0, 4] },
          scale: o.leftMin === undefined, min: o.leftMin, max: o.leftMax,
          splitLine: { lineStyle: { color: '#F2F4F8', type: 'dashed' } },
          axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM }
        },
        {
          type: 'value', name: o.rightName || '', nameTextStyle: { color: '#A9B0BC', fontSize: 10, padding: [0, 0, 0, -8] },
          scale: true, min: o.rightMin || 88, max: o.rightMax || 100,
          splitLine: { show: false },
          axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, formatter: '{value}%' }
        }
      ],
      series: series.map(function (s, i) {
        return {
          name: s.name,
          type: 'line',
          yAxisIndex: s.axis || 0,
          data: s.data,
          smooth: 0.32,
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { width: s.dashed ? 1.6 : 2.2, type: s.dashed ? 'dashed' : 'solid' },
          itemStyle: { color: s.color, borderColor: '#fff', borderWidth: 2 },
          areaStyle: s.area ? {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: hexA(s.color, .16) },
              { offset: 1, color: hexA(s.color, 0) }
            ])
          } : undefined,
          emphasis: { focus: 'series' },
          z: 3 - i
        };
      }),
      animationDuration: 900,
      animationEasing: 'cubicOut'
    };
  }

  /* ------------------------------------------------------------------
     4. 横向条形（慢病占比 / 类型分布）
     ------------------------------------------------------------------ */
  function hBarOption(data, opts) {
    var o = opts || {};
    var max = o.max || Math.max.apply(null, data.map(function (d) { return d.value; })) * 1.25;
    return {
      tooltip: tooltip({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(22,93,255,.04)' } },
        formatter: function (ps) {
          var p = ps[0];
          return p.name + '：<b style="font-family:' + NUM + '">' + U.fmt(p.value, o.digits || 0) + '</b>' + (o.suffix || '');
        }
      }),
      grid: baseGrid({ top: 4, bottom: 0, left: 2, right: 46 }),
      xAxis: { type: 'value', show: false, max: max },
      yAxis: {
        type: 'category',
        inverse: true,
        data: data.map(function (d) { return d.name; }),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: TEXT_2, fontSize: 11.5, fontFamily: FONT, margin: 12 }
      },
      series: [{
        type: 'bar',
        barWidth: 9,
        showBackground: true,
        backgroundStyle: { color: '#F1F4F9', borderRadius: 5 },
        data: data.map(function (d) {
          return { value: d.value, itemStyle: { color: d.color || '#165DFF', borderRadius: 5 } };
        }),
        label: {
          show: true,
          position: 'right',
          color: TEXT_2,
          fontSize: 11,
          fontFamily: NUM,
          formatter: function (p) { return U.fmt(p.value, o.digits || 0) + (o.suffix || ''); }
        }
      }],
      animationDuration: 800,
      animationDelay: function (i) { return i * 70; }
    };
  }

  /* ------------------------------------------------------------------
     5. 堆叠柱状（月度服务量）
     ------------------------------------------------------------------ */
  function stackBarOption(labels, series) {
    return {
      color: series.map(function (s) { return s.color; }),
      tooltip: tooltip({ trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(22,93,255,.05)' } } }),
      legend: {
        top: 0, right: 0, icon: 'circle', itemWidth: 7, itemHeight: 7, itemGap: 12,
        textStyle: { color: TEXT_3, fontSize: 11, fontFamily: FONT }
      },
      grid: baseGrid({ top: 30, bottom: 0 }),
      xAxis: {
        type: 'category', data: labels,
        axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, margin: 10 }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#F2F4F8', type: 'dashed' } },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM }
      },
      series: series.map(function (s, i) {
        return {
          name: s.name, type: 'bar', stack: 'total', barWidth: 22,
          data: s.data,
          itemStyle: { borderRadius: i === series.length - 1 ? [4, 4, 0, 0] : 0 },
          emphasis: { focus: 'series' }
        };
      }),
      animationDuration: 820,
      animationDelay: function (i) { return i * 60; }
    };
  }

  /* ------------------------------------------------------------------
     6. 双轴：完成率 + 响应时长
     ------------------------------------------------------------------ */
  function efficiencyOption(labels, completion, response) {
    return {
      tooltip: tooltip({ trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#C9D5E8', type: 'dashed' } } }),
      legend: {
        top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 3, itemGap: 14,
        textStyle: { color: TEXT_3, fontSize: 11, fontFamily: FONT }
      },
      grid: baseGrid({ top: 30, bottom: 0, right: 30 }),
      xAxis: {
        type: 'category', data: labels, boundaryGap: true,
        axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, margin: 10 }
      },
      yAxis: [
        {
          type: 'value', min: 88, max: 100,
          splitLine: { lineStyle: { color: '#F2F4F8', type: 'dashed' } },
          axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, formatter: '{value}%' }
        },
        {
          type: 'value', min: 0, max: 14,
          splitLine: { show: false },
          axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, formatter: '{value}m' }
        }
      ],
      series: [
        {
          name: '工单完成率', type: 'bar', barWidth: 18, data: completion,
          itemStyle: { color: hexA('#165DFF', .32), borderColor: hexA('#165DFF', .5), borderWidth: 1, borderRadius: [4, 4, 0, 0] }
        },
        {
          name: '平均响应时长', type: 'line', yAxisIndex: 1, data: response,
          smooth: 0.3, symbol: 'circle', symbolSize: 6,
          lineStyle: { color: '#FF7D00', width: 2 },
          itemStyle: { color: '#FF7D00', borderColor: '#fff', borderWidth: 2 }
        }
      ],
      animationDuration: 820
    };
  }

  /* ------------------------------------------------------------------
     7. 面积趋势（设备在线率）
     ------------------------------------------------------------------ */
  function areaOption(labels, values, opts) {
    var o = opts || {};
    return {
      color: [o.color || '#165DFF'],
      tooltip: tooltip({
        trigger: 'axis',
        formatter: function (ps) {
          return ps[0].name + '：<b style="font-family:' + NUM + '">' + ps[0].value + '%</b>';
        }
      }),
      grid: baseGrid({ top: 14, bottom: 0, left: 2, right: 12 }),
      xAxis: {
        type: 'category', data: labels, boundaryGap: false,
        axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, margin: 10 }
      },
      yAxis: {
        type: 'value', min: o.min || 88, max: 100,
        splitLine: { lineStyle: { color: '#F2F4F8', type: 'dashed' } },
        axisLabel: { color: TEXT_3, fontSize: 10.5, fontFamily: NUM, formatter: '{value}%' }
      },
      series: [{
        type: 'line', data: values, smooth: 0.34, showSymbol: false,
        lineStyle: { width: 2.2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexA(o.color || '#165DFF', .22) },
            { offset: 1, color: hexA(o.color || '#165DFF', 0) }
          ])
        }
      }],
      animationDuration: 820
    };
  }

  /* ------------------------------------------------------------------
     8. 告警 24 小时分布
     ------------------------------------------------------------------ */
  function alertHoursOption(values) {
    var labels = [];
    for (var i = 0; i < 24; i++) labels.push(U.pad2(i) + ':00');
    return {
      tooltip: tooltip({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(245,63,63,.05)' } },
        formatter: function (ps) {
          return ps[0].name + ' — ' + ps[0].name.replace(':00', ':59') + '<br/>告警 <b style="font-family:' + NUM + '">' + ps[0].value + '</b> 条';
        }
      }),
      grid: baseGrid({ top: 16, bottom: 0, left: 2, right: 8 }),
      xAxis: {
        type: 'category', data: labels,
        axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
        axisLabel: {
          color: TEXT_3, fontSize: 10, fontFamily: NUM, interval: 3, margin: 8
        }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#F2F4F8', type: 'dashed' } },
        axisLabel: { color: TEXT_3, fontSize: 10, fontFamily: NUM }
      },
      series: [{
        type: 'bar', data: values, barWidth: 7,
        itemStyle: { color: '#F53F3F', opacity: .82, borderRadius: [3, 3, 0, 0] },
        emphasis: { itemStyle: { opacity: 1 } }
      }],
      animationDuration: 760
    };
  }

  /* ------------------------------------------------------------------
     9. 雷达（服务效能）
     ------------------------------------------------------------------ */
  function radarOption(indicators, values) {
    return {
      tooltip: tooltip({ trigger: 'item' }),
      radar: {
        center: ['50%', '54%'],
        radius: '66%',
        indicator: indicators,
        splitNumber: 4,
        axisName: { color: TEXT_3, fontSize: 10.5, fontFamily: FONT },
        axisLine: { lineStyle: { color: '#EDF0F6' } },
        splitLine: { lineStyle: { color: '#EDF0F6' } },
        splitArea: { areaStyle: { color: ['#FFFFFF', '#FAFBFD'] } }
      },
      series: [{
        type: 'radar',
        data: [{
          value: values,
          name: '服务效能',
          areaStyle: { color: hexA('#165DFF', .14) },
          lineStyle: { color: '#165DFF', width: 2 },
          itemStyle: { color: '#165DFF' }
        }]
      }],
      animationDuration: 800
    };
  }

  /* ------------------------------------------------------------------
     工具：hex -> rgba
     ------------------------------------------------------------------ */
  function hexA(hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* ------------------------------------------------------------------
     纯 SVG 评分环（避免为一个指标引入 gauge）
     ------------------------------------------------------------------ */
  function scoreRing(value, opts) {
    var o = opts || {};
    var size = o.size || 96;
    var stroke = o.stroke || 8;
    var color = o.color || '#165DFF';
    var radius = (size - stroke) / 2;
    var c = 2 * Math.PI * radius;
    var pct = Math.max(0, Math.min(100, value)) / 100;
    return '<div class="score-ring" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
        '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '" fill="none" stroke="#EFF2F7" stroke-width="' + stroke + '"/>' +
        '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '" fill="none" stroke="' + color + '" stroke-width="' + stroke +
          '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct)) +
          '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')" class="ring-progress"/>' +
      '</svg>' +
      '<div class="score-ring-text"><b class="num">' + Math.round(value) + '</b><span>' + (o.label || '分') + '</span></div>' +
    '</div>';
  }

  global.YL.charts = {
    PALETTE: PALETTE,
    tooltip: tooltip,
    mount: mount,
    disposeAll: disposeAll,
    resizeAll: resizeAll,
    donutOption: donutOption,
    deviceBarOption: deviceBarOption,
    vitalTrendOption: vitalTrendOption,
    hBarOption: hBarOption,
    stackBarOption: stackBarOption,
    efficiencyOption: efficiencyOption,
    areaOption: areaOption,
    alertHoursOption: alertHoursOption,
    radarOption: radarOption,
    scoreRing: scoreRing,
    hexA: hexA
  };
})(window);