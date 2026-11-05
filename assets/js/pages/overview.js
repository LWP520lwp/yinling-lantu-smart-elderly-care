/* ==========================================================================
   页面 2：系统总览（数据大屏首页）
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;
  var C = YL.charts;

  /** 老人姓名展示文本：管理员会话显示原文，其余角色一律脱敏（utils.maskName） */
  function maskElderName(name) {
    return U.canSeeRaw() ? (name || '') : U.maskName(name);
  }

  var timers = [];
  var mapTip = null;
  var liveItems = [];

  function panel(title, extra, body, cls, iconName) {
    return '<article class="panel ' + (cls || '') + '">' +
      '<div class="panel-head">' +
        '<div class="panel-title">' + (iconName ? YL.icon(iconName) : '') + '<span>' + title + '</span></div>' +
        '<div class="panel-extra">' + (extra || '') + '</div>' +
      '</div>' +
      '<div class="panel-body">' + body + '</div>' +
    '</article>';
  }

  function kpi(label, value, unit, foot, tone, trend) {
    return '<div class="dash-kpi ' + (tone || '') + '">' +
      '<span class="kpi-label">' + label + (trend ? '<i class="kpi-trend ' + (trend.tone || '') + '">' + trend.text + '</i>' : '') + '</span>' +
      '<b class="kpi-value num" data-count="' + value + '">0</b>' +
      (unit ? '<span class="kpi-unit">' + unit + '</span>' : '') +
      '<em class="kpi-foot">' + foot + '</em>' +
    '</div>';
  }

  function alertRow(a) {
    var type = D.DICT.alertType[a.type];
    var status = D.DICT.alertStatus[a.status];
    var critical = a.level === 'critical';
    return '<li class="alert-row' + (critical ? ' is-critical' : '') + '">' +
      '<span class="alert-type ' + (critical ? 'critical' : '') + '">' + YL.icon(critical ? 'alert' : type.icon) + '</span>' +
      '<div class="alert-main">' +
        '<b>' + U.esc(maskElderName(a.elderName)) + ' · ' + type.text + '</b>' +
        '<em>' + U.esc(a.village) + ' · ' + U.esc(a.metric) + '</em>' +
      '</div>' +
      '<div class="alert-side">' +
        '<b>' + U.relTime(a.time) + '</b>' +
        '<em class="' + (critical ? 'is-critical' : '') + '">' + (a.status === 'pending' ? '待处置' : status.text) + '</em>' +
      '</div>' +
    '</li>';
  }

  function render(container, route) {
    var summary = D.SUMMARY;
    var now = new Date();

    var healthTotal = summary.elderTotal;
    var h = summary.health;

    var html =
      '<div class="page page-overview">' +

        /* ---------- 顶部通栏 ---------- */
        '<header class="dash-head">' +
          '<div class="dash-title">' +
            '<div class="dash-eyebrow"><span class="live-dot"></span>实时态势 · 数据每 30 秒同步 · 华为云 IoT 设备接入</div>' +
            '<h1>平潭综合实验区 <span>养老服务运行态势</span></h1>' +
            '<p class="dash-date">' + U.fmtDateCN(now) + ' · 数据更新于 <b class="num" id="dashClock">' + U.fmtClock(now) + '</b></p>' +
          '</div>' +
          '<div class="dash-kpis">' +
            kpi('总服务老人', healthTotal, '人', '覆盖 42 个合作村居', 'is-brand', { text: '本月 +42', tone: 'up' }) +
            kpi('在线设备', summary.deviceOnline, '台', '在线率 ' + summary.deviceOnlineRate + '%', 'is-green', { text: '鸿蒙智联', tone: 'flat' }) +
            kpi('今日告警', summary.todayAlerts, '条', summary.alertPending + ' 条待处置', 'is-red', { text: '较昨日 -3', tone: 'down' }) +
            kpi('今日工单', summary.todayOrders, '单', '已完成 ' + summary.orderDone + ' 单', 'is-orange', { text: '完成率 96.4%', tone: 'flat' }) +
          '</div>' +
        '</header>' +

        /* ---------- 三栏大屏 ---------- */
        '<div class="dash-grid">' +

          /* 左栏：健康 / 设备 / 村居地图 */
          '<section class="dash-col dash-col-left">' +
            panel('老人健康状态分布',
              '<span class="panel-note">在册 1,504 人</span>',
              '<div class="donut-layout">' +
                '<div class="donut-canvas"><div class="chart" id="chHealth"></div>' +
                  '<div class="donut-center"><b class="num">' + U.fmt(healthTotal) + '</b><span>服务老人</span></div>' +
                '</div>' +
                '<ul class="donut-legend">' +
                  '<li><i style="background:#00B42A"></i><span>健康老人</span><b class="num">' + h.healthy + '</b><em>' + U.pct(h.healthy / healthTotal * 100) + '</em></li>' +
                  '<li><i style="background:#FF7D00"></i><span>半自理老人</span><b class="num">' + h.semi + '</b><em>' + U.pct(h.semi / healthTotal * 100) + '</em></li>' +
                  '<li><i style="background:#F53F3F"></i><span>失能老人</span><b class="num">' + h.disabled + '</b><em>' + U.pct(h.disabled / healthTotal * 100) + '</em></li>' +
                '</ul>' +
              '</div>',
              'panel-health', 'heart') +

            panel('手环设备在线状态',
              '<span class="pill pill-brand">在线率 ' + summary.deviceOnlineRate + '%</span>',
              '<div class="chart" id="chDevice" style="height:132px"></div>' +
              '<div class="panel-footline"><span>接入总量 <b class="num">' + U.fmt(summary.deviceTotal) + '</b> 台</span><span>故障 <b class="num">' + summary.deviceFault + '</b> 台</span><span>离线 <b class="num">' + summary.deviceOffline + '</b> 台</span></div>',
              'panel-device', 'watch') +

            panel('村居服务覆盖',
              '<button type="button" class="btn-link" data-go-reports>查看覆盖报表</button>',
              '<div class="map-wrap">' +
                '<div class="map-canvas">' +
                '<svg class="pt-map" id="ptMap" viewBox="28 8 292 268" role="img" aria-label="平潭综合实验区村居服务覆盖示意图">' +
                  '<defs>' +
                    '<linearGradient id="mapFill" x1="0" y1="0" x2="1" y2="1">' +
                      '<stop offset="0" stop-color="#DCE9FF"/><stop offset="1" stop-color="#EFF5FF"/>' +
                    '</linearGradient>' +
                    '<radialGradient id="mapGlow" cx="50%" cy="50%" r="50%">' +
                      '<stop offset="0" stop-color="#FF7D00" stop-opacity=".18"/>' +
                      '<stop offset="1" stop-color="#FF7D00" stop-opacity="0"/>' +
                    '</radialGradient>' +
                  '</defs>' +
                  '<circle cx="176" cy="140" r="120" fill="url(#mapGlow)"/>' +
                  '<path id="islandPath" d="M168 22C186 20 202 33 209 50C216 66 208 82 214 96C221 111 236 118 238 134C240 149 226 158 228 174C230 190 244 199 238 214C232 229 214 232 206 246C200 257 188 264 176 258C164 252 160 236 148 230C134 223 116 226 106 214C96 202 104 187 98 174C92 161 76 152 78 138C80 124 96 116 100 102C104 88 94 74 100 60C106 46 122 44 132 34C142 24 154 23 168 22Z" fill="url(#mapFill)" stroke="#BBD3F7" stroke-width="1.2"/>' +
                  '<path d="M262 74c9-3 16 3 15 11-1 8-11 11-17 6-5-4-4-14 2-17Z" fill="#E6EFFF" stroke="#C6D8F5" stroke-width="1"/>' +
                  '<path d="M62 206c8-3 15 2 14 9-1 7-10 10-16 5-4-3-3-12 2-14Z" fill="#E6EFFF" stroke="#C6D8F5" stroke-width="1"/>' +
                  '<path d="M96 34c7-2 12 3 11 8-1 6-8 8-13 4-4-3-3-10 2-12Z" fill="#E6EFFF" stroke="#C6D8F5" stroke-width="1"/>' +
                  '<g id="villagePoints"></g>' +
                '</svg>' +
                '</div>' +
                '<div class="map-side">' +
                  '<div class="map-kpi"><b class="num">42</b><span>合作村居</span></div>' +
                  '<div class="map-kpi"><b class="num">' + summary.coverageRate + '%</b><span>整体覆盖率</span></div>' +
                  '<div class="map-kpi"><b class="num">18</b><span>覆盖率 ≥ 90%</span></div>' +
                  '<ul class="map-legend">' +
                    '<li><i style="background:#165DFF"></i>覆盖率 ≥ 90%</li>' +
                    '<li><i style="background:#7BA8FF"></i>75% - 90%</li>' +
                    '<li><i style="background:#FF7D00"></i>低于 75%</li>' +
                  '</ul>' +
                '</div>' +
              '</div>',
              'panel-map', 'map-pin') +
          '</section>' +

          /* 中栏：实时告警 + 体征趋势 */
          '<section class="dash-col dash-col-center">' +
            panel('实时告警动态',
              '<div class="panel-extra-inline">' +
                '<span class="live-tag"><span class="live-dot"></span>LIVE</span>' +
                '<button type="button" class="btn-link" data-go-alerts>全部告警</button>' +
              '</div>',
              '<div class="alert-stream" id="alertStream">' +
                '<ul class="alert-list">' +
                  S.alerts().slice(0, 5).map(alertRow).join('') +
                '</ul>' +
              '</div>' +
              '<div class="alert-stream-foot">' +
                '<span><i class="dot red"></i>紧急 3 条</span><span><i class="dot orange"></i>一般 3 条</span>' +
                '<button type="button" class="btn btn-sm btn-soft" data-go-alerts>进入处置台</button>' +
              '</div>',
              'panel-alerts', 'alert') +

            panel('全域老人核心体征趋势',
              '<div class="segmented segmented-sm" id="trendRange">' +
                '<button type="button" class="active" data-days="7">近 7 天</button>' +
                '<button type="button" data-days="14">近 14 天</button>' +
              '</div>',
              '<div class="chart trend-chart" id="chTrend"></div>' +
              '<div class="trend-summary">' +
                '<div><span>平均心率</span><b class="num">79</b><em>bpm</em><i class="delta-up">+2.4%</i></div>' +
                '<div><span>平均血压</span><b class="num">136/84</b><em>mmHg</em><i class="delta-up">+1.8%</i></div>' +
                '<div><span>平均血氧</span><b class="num">95.9</b><em>%</em><i class="delta-down">-0.3%</i></div>' +
                '<div><span>异常体征老人</span><b class="num">43</b><em>人</em><i class="delta-up">需随访</i></div>' +
              '</div>',
              'panel-trend', 'activity') +
          '</section>' +

          /* 右栏：工单 / 志愿 / 兜底 */
          '<section class="dash-col dash-col-right">' +
            panel('本月服务工单',
              '<button type="button" class="btn-link" data-go-orders>工单台账</button>',
              '<div class="svc-total"><b class="num">' + U.fmt(410) + '</b><span>本月累计服务单量</span><i class="tag tag-green">完成率 ' + summary.completionRate + '%</i></div>' +
              '<div class="svc-list">' +
                [
                  ['上门关怀', summary.orderTypes.care, 'brand'],
                  ['陪诊服务', summary.orderTypes.accompany, 'orange'],
                  ['康复护理', summary.orderTypes.rehab, 'green'],
                  ['家政帮助', summary.orderTypes.house, 'cyan']
                ].map(function (row) {
                  var max = summary.orderTypes.care;
                  return '<div class="svc-row">' +
                    '<div class="svc-row-head"><span>' + row[0] + '</span><b class="num">' + row[1] + '</b></div>' +
                    '<div class="bar ' + (row[2] === 'brand' ? '' : row[2]) + '"><i style="width:' + (row[1] / max * 100) + '%"></i></div>' +
                  '</div>';
                }).join('') +
              '</div>' +
              '<div class="panel-footline"><span>平均响应 <b class="num">' + summary.responseAvg + '</b> 分钟</span><span>待处理 <b class="num">' + summary.orderPending + '</b> 单</span></div>',
              'panel-orders', 'clipboard') +

            panel('志愿帮扶队伍',
              '<span class="pill pill-orange">在册 ' + summary.volunteers + ' 人</span>',
              '<div class="volunteer">' +
                '<div class="volunteer-main">' +
                  '<div><b class="num">' + U.fmt(summary.volunteerHours) + '</b><span>累计服务时长（小时）</span></div>' +
                  '<div class="volunteer-sub"><span>本月新增 <b class="num">' + U.fmt(summary.volunteerHoursMonth) + '</b> 小时</span><span>结对帮扶 <b class="num">214</b> 户</span></div>' +
                '</div>' +
                '<div class="volunteer-ring">' +
                  C.scoreRing(78, { size: 78, stroke: 7, color: '#FF7D00', label: '%' }) +
                  '<em>年度目标达成</em>' +
                '</div>' +
              '</div>' +
              '<div class="volunteer-teams">' +
                ['平潭义工协会', '福州工商学院', '银龄岚途志愿队'].map(function (n, i) {
                  return '<span><i style="background:' + ['#165DFF', '#FF7D00', '#00B42A'][i] + '"></i>' + n + '</span>';
                }).join('') +
              '</div>',
              'panel-volunteer', 'users') +

            '<article class="panel panel-guarantee">' +
              '<div class="guarantee-head">' +
                '<div class="panel-title">' + YL.icon('shield') + '<span>兜底保障服务</span></div>' +
                '<span class="pill">政府购买</span>' +
              '</div>' +
              '<div class="guarantee-body">' +
                '<div class="guarantee-num"><b class="num">' + summary.guarantee + '</b><span>位兜底老人享受免费服务</span></div>' +
                '<div class="guarantee-meta">' +
                  '<span>覆盖 12 个乡镇</span><span>本月新增 6 人</span><span>服务响应 100%</span>' +
                '</div>' +
              '</div>' +
              '<div class="guarantee-foot">' +
                '<span>低保、特困、失能兜底对象由财政全额保障</span>' +
                '<button type="button" class="btn-link" data-go-elders>查看名单</button>' +
              '</div>' +
            '</article>' +
          '</section>' +
        '</div>' +

        '<footer class="dash-foot">' +
          '<span>数据来源 · 华为云 IoT 设备接入平台（IoTDA）实时上报</span>' +
          '<span>统计口径：2026 年 11 月 · 平潭综合实验区民政局养老服务指导中心</span>' +
        '</footer>' +
      '</div>';

    container.innerHTML = html;
    YL.hydrateIcons(container);

    animateNumbers(container);
    mountCharts(container);
    buildMap(container);
    bindEvents(container);

    timers.push(setInterval(function () {
      var clock = document.getElementById('dashClock');
      if (clock) clock.textContent = U.fmtClock(new Date());
    }, 1000));

    timers.push(setInterval(function () {
      if (document.hidden) return;
      refreshAlertStream(container);
    }, 9000));
  }

  function animateNumbers(root) {
    U.qsa('[data-count]', root).forEach(function (node) {
      var to = Number(node.getAttribute('data-count'));
      U.countUp(node, to, { duration: 900 });
    });
  }

  function mountCharts(root) {
    var h = D.SUMMARY.health;

    C.mount(root.querySelector('#chHealth'), C.donutOption([
      { name: '健康老人', value: h.healthy, itemStyle: { color: '#00B42A' } },
      { name: '半自理老人', value: h.semi, itemStyle: { color: '#FF7D00' } },
      { name: '失能老人', value: h.disabled, itemStyle: { color: '#F53F3F' } }
    ], null, { legend: false, radius: ['62%', '84%'], center: ['50%', '50%'] }));

    C.mount(root.querySelector('#chDevice'), C.deviceBarOption([
      { name: '在线', value: D.SUMMARY.deviceOnline, color: '#00B42A' },
      { name: '离线', value: D.SUMMARY.deviceOffline, color: '#A9B0BC' },
      { name: '故障', value: D.SUMMARY.deviceFault, color: '#F53F3F' }
    ]));

    var t = D.TREND7;
    var chart = C.mount(root.querySelector('#chTrend'), C.vitalTrendOption(t.labels, [
      { name: '平均心率 (bpm)', data: t.hr, color: '#165DFF', area: true },
      { name: '平均收缩压 (mmHg)', data: t.sbp, color: '#FF7D00' },
      { name: '平均血氧 (%)', data: t.spo2, color: '#00B42A', axis: 1, dashed: true }
    ], { leftName: '', rightName: '%', leftMin: 60, leftMax: 160 }));

    var rangeBtns = root.querySelectorAll('#trendRange [data-days]');
    Array.prototype.forEach.call(rangeBtns, function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(rangeBtns, function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var days = Number(btn.getAttribute('data-days'));
        var labels = [], hr = [], sbp = [], spo2 = [];
        var baseHr = 76, baseSbp = 133, baseSpo2 = 96.3;
        for (var i = days - 1; i >= 0; i--) {
          var wobble = Math.sin(i * 1.4) * 2.2;
          labels.push(U.fmtDate(U.daysAgo(i), 'MM-DD'));
          hr.push(Math.round(baseHr + wobble + (days - i) * .18));
          sbp.push(Math.round(baseSbp + wobble * .8 + (days - i) * .22));
          spo2.push(U.round(baseSpo2 + Math.sin(i * .9) * .5, 1));
        }
        chart.setOption(C.vitalTrendOption(labels, [
          { name: '平均心率 (bpm)', data: hr, color: '#165DFF', area: true },
          { name: '平均收缩压 (mmHg)', data: sbp, color: '#FF7D00' },
          { name: '平均血氧 (%)', data: spo2, color: '#00B42A', axis: 1, dashed: true }
        ], { leftMin: 60, leftMax: 160 }), true);
      });
    });
  }

  /* ------------------------------------------------------------------
     村居覆盖地图
     ------------------------------------------------------------------ */
  var TOWN_CENTERS = {
    '海坛街道': [166, 208],
    '澳前镇': [200, 168],
    '北厝镇': [152, 176],
    '流水镇': [212, 118],
    '平原镇': [176, 96],
    '苏澳镇': [134, 84],
    '敖东镇': [138, 206],
    '白青乡': [118, 62],
    '屿头乡': [92, 126],
    '大练乡': [80, 88],
    '南海乡': [196, 246],
    '中楼乡': [150, 132]
  };

  function buildMap(root) {
    var svg = root.querySelector('#ptMap');
    var layer = root.querySelector('#villagePoints');
    if (!svg || !layer) return;
    var path = svg.querySelector('#islandPath');
    var r = U.rng(4211);
    var limit = 60;

    D.VILLAGES.forEach(function (v) {
      var c = TOWN_CENTERS[v.town] || [170, 140];
      var x = c[0], y = c[1], ok = true, tries = 0;
      do {
        var angle = r() * Math.PI * 2;
        var radius = 6 + r() * 26;
        x = c[0] + Math.cos(angle) * radius;
        y = c[1] + Math.sin(angle) * radius * .92;
        try {
          ok = path.isPointInFill(new DOMPoint(x, y));
        } catch (e) {
          ok = true;
        }
        tries++;
      } while (!ok && tries < limit);

      var color = v.rate >= 90 ? '#165DFF' : (v.rate >= 75 ? '#7BA8FF' : '#FF7D00');
      var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', (2.6 + (v.rate - 45) / 100 * 2.4).toFixed(1));
      dot.setAttribute('fill', color);
      dot.setAttribute('fill-opacity', '.9');
      dot.setAttribute('stroke', '#fff');
      dot.setAttribute('stroke-width', '.9');
      dot.setAttribute('class', 'v-dot');
      dot.setAttribute('data-village', v.name);
      dot.setAttribute('tabindex', '0');
      dot.setAttribute('role', 'button');
      dot.setAttribute('aria-label', v.name + ' 服务覆盖率 ' + v.rate + '%');
      layer.appendChild(dot);

      // 高覆盖村居外圈呼吸
      if (v.rate >= 94) {
        var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', x.toFixed(1));
        ring.setAttribute('cy', y.toFixed(1));
        ring.setAttribute('r', '7');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', color);
        ring.setAttribute('stroke-opacity', '.35');
        ring.setAttribute('class', 'v-ring');
        layer.insertBefore(ring, dot);
      }

      dot.addEventListener('mouseenter', function (e) { showMapTip(e, v); });
      dot.addEventListener('mousemove', function (e) { moveMapTip(e); });
      dot.addEventListener('mouseleave', hideMapTip);
      dot.addEventListener('click', function () {
        YL.router.go('/elders?village=' + encodeURIComponent(v.name));
      });
      dot.addEventListener('focus', function (e) {
        var rect = dot.getBoundingClientRect();
        showMapTip({ clientX: rect.left + rect.width / 2, clientY: rect.top }, v);
      });
      dot.addEventListener('blur', hideMapTip);
    });
  }

  function showMapTip(e, v) {
    hideMapTip();
    mapTip = U.el('<div class="chart-tip map-tip">' +
      '<b>' + U.esc(v.name) + '</b> · ' + U.esc(v.town) +
      '<br/>服务老人 <b class="num">' + v.total + '</b> 人 · 覆盖率 <b class="num">' + v.rate + '%</b>' +
      '<br/><span style="opacity:.65">点击查看该村居老人档案</span>' +
      '</div>');
    document.body.appendChild(mapTip);
    moveMapTip(e);
  }

  function moveMapTip(e) {
    if (!mapTip) return;
    mapTip.style.left = e.clientX + 'px';
    mapTip.style.top = (e.clientY - 12) + 'px';
  }

  function hideMapTip() {
    if (mapTip && mapTip.parentNode) mapTip.parentNode.removeChild(mapTip);
    mapTip = null;
  }

  /* ------------------------------------------------------------------
     告警流刷新
     ------------------------------------------------------------------ */
  function refreshAlertStream(root) {
    var list = root.querySelector('.alert-list');
    if (!list) return;
    var items = S.alerts().slice(0, 5);
    var signature = items.map(function (a) { return a.id + a.status; }).join('|');
    if (signature === liveItems.join('|')) return;
    liveItems = items.map(function (a) { return a.id + a.status; });
    list.style.opacity = '0';
    setTimeout(function () {
      list.innerHTML = items.map(alertRow).join('');
      list.style.opacity = '1';
    }, 180);
  }

  function bindEvents(root) {
    U.qsa('[data-go-alerts]', root).forEach(function (b) {
      b.addEventListener('click', function () { YL.router.go('/alerts'); });
    });
    U.qsa('[data-go-orders]', root).forEach(function (b) {
      b.addEventListener('click', function () { YL.router.go('/orders'); });
    });
    U.qsa('[data-go-elders]', root).forEach(function (b) {
      b.addEventListener('click', function () { YL.router.go('/elders?member=free'); });
    });
    U.qsa('[data-go-reports]', root).forEach(function (b) {
      b.addEventListener('click', function () { YL.router.go('/reports'); });
    });
    U.qsa('.alert-row', root).forEach(function (row) {
      row.addEventListener('click', function () { YL.router.go('/alerts'); });
    });
  }

  function onLiveAlert(alert) {
    liveItems = [];
    var view = document.getElementById('view');
    if (view) refreshAlertStream(view);
  }

  function destroy() {
    timers.forEach(function (t) { clearInterval(t); });
    timers = [];
    hideMapTip();
  }

  YL.pages = YL.pages || {};
  YL.pages.overview = { render: render, destroy: destroy, onLiveAlert: onLiveAlert };
})(window);