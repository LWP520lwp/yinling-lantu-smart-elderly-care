/* ==========================================================================
   家属视图：仅本人绑定老人的健康详情与服务记录（只读、轻量）
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;
  var C = YL.charts;

  var TABS = [
    { key: 'overview', label: '今日概况' },
    { key: 'vitals', label: '体征档案' },
    { key: 'alerts', label: '告警记录' },
    { key: 'orders', label: '服务记录' },
    { key: 'device', label: '设备状态' }
  ];

  /** 仅返回当前账号已绑定的老人；未绑定返回 null，不回退 mock 数据避免越权展示 */
  function myElder() {
    return S.elders()[0] || null;
  }

  function render(container, route) {
    var elder = myElder();
    if (!elder) {
      container.innerHTML = '<div class="page">' +
        UI.empty('shield', '尚未绑定老人', '当前账号还没有绑定老人档案，请联系村居社工完成绑定。',
          '<a class="btn btn-primary" href="#/family">刷新</a>') +
        '</div>';
      YL.hydrateIcons(container);
      return;
    }
    var tab = (route.query && route.query.tab) || 'overview';
    if (!TABS.some(function (t) { return t.key === tab; })) tab = 'overview';
    var v = elder.lastVitals;
    /* 仅取当前账号绑定的设备，不回退 mock 设备 */
    var device = S.devices()[0];

    container.innerHTML =
      '<div class="page page-family">' +
        '<section class="family-hero">' +
          '<div class="family-hero-main">' +
            '<span class="avatar avatar-lg ' + elder.avatarClass + '">' + U.esc(elder.name.slice(0, 1)) + '</span>' +
            '<div class="family-hero-info">' +
              '<div class="family-hero-name"><h1>' + U.esc(elder.name) + '</h1>' +
                UI.healthTag(elder.health) +
                '<span class="tag tag-outline">' + D.DICT.member[elder.member].text + '</span></div>' +
              '<p>' + elder.gender + ' · ' + elder.age + ' 岁 · ' + U.esc(elder.village) + ' · 家属 ' + U.esc(elder.familyName) + '（' + U.esc(elder.relation) + '）</p>' +
              '<div class="family-hero-tags">' +
                '<span class="status online"><span class="dot"></span>' + (device ? '手环在线' : '未绑定手环') + '</span>' +
                '<span>' + U.relTime(v.at) + '更新体征数据</span>' +
                '<span class="num">' + (device ? U.esc(device.id) : '—') + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="family-hero-vitals">' +
            vitalBox('心率', v.hr, 'bpm', v.hr > 100 ? '偏高' : v.hr < 55 ? '偏低' : '正常', v.hr > 100 || v.hr < 55) +
            vitalBox('血压', v.sbp + '/' + v.dbp, 'mmHg', v.sbp > 150 ? '偏高' : '正常', v.sbp > 150) +
            vitalBox('血氧', v.spo2, '%', v.spo2 < 94 ? '偏低' : '正常', v.spo2 < 94) +
            vitalBox('体温', v.temp, '℃', v.temp > 37.3 ? '发热' : '正常', v.temp > 37.3) +
          '</div>' +
        '</section>' +

        '<div class="family-tabs">' +
          TABS.map(function (t) {
            return '<button type="button" class="family-tab' + (tab === t.key ? ' active' : '') + '" data-tab="' + t.key + '">' + t.label + '</button>';
          }).join('') +
        '</div>' +

        '<div class="family-body" id="familyBody">' + bodyFor(tab, elder, device) + '</div>' +

        '<p class="family-footer">数据由「银龄守护」手环经华为云 IoT 平台加密上传 · AI 建议仅供参考，不作为诊疗依据</p>' +
      '</div>';

    YL.hydrateIcons(container);
    bind(container, route);
    mountCharts(container, tab, elder);
  }

  function vitalBox(label, value, unit, status, abnormal) {
    return '<div class="family-vital' + (abnormal ? ' is-abnormal' : '') + '">' +
      '<span>' + label + '</span>' +
      '<b class="num">' + value + '</b>' +
      '<em>' + unit + '</em>' +
      '<i class="' + (abnormal ? 'warn' : 'ok') + '">' + status + '</i>' +
    '</div>';
  }

  function bodyFor(tab, elder, device) {
    if (tab === 'vitals') {
      return '<div class="card">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('activity') + '近 30 天体征档案</div>' +
          '<span class="card-sub">心率 / 血压</span></div>' +
        '<div class="card-body"><div class="chart" id="chFamilyVital" style="height:240px"></div></div>' +
      '</div>' +
      '<div class="card mt-4">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('droplet') + '血氧饱和度</div>' +
          '<span class="card-sub">正常区间 95% - 100%</span></div>' +
        '<div class="card-body"><div class="chart" id="chFamilySpo2" style="height:180px"></div></div>' +
      '</div>';
    }

    if (tab === 'alerts') {
      var alerts = S.alerts().filter(function (a) { return a.elderId === elder.id; });
      return '<div class="card">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('alert') + '告警记录</div>' +
          '<span class="card-sub">共 ' + alerts.length + ' 条</span></div>' +
        '<div class="card-body">' +
          (alerts.length ? '<div class="family-alert-list">' + alerts.map(function (a) {
            var type = D.DICT.alertType[a.type];
            return '<div class="family-alert">' +
              '<span class="family-alert-icon ' + (a.level === 'critical' ? 'critical' : '') + '">' + YL.icon(type.icon) + '</span>' +
              '<div class="family-alert-main">' +
                '<div><b>' + type.text + '</b>' + UI.statusTag(D.DICT.alertStatus, a.status) + '</div>' +
                '<p>' + U.fmtDate(a.time, 'MM-DD HH:mm') + ' · ' + U.esc(a.metric) + '</p>' +
                (a.result ? '<em>处置结果：' + U.esc(a.result) + '</em>' : '<em>村居社工正在处置中</em>') +
              '</div>' +
              '<span class="tag ' + D.DICT.alertLevel[a.level].cls + '">' + D.DICT.alertLevel[a.level].text + '</span>' +
            '</div>';
          }).join('') + '</div>' :
            UI.empty('shield', '暂无告警记录', '老人近 30 天未触发设备告警，请放心。'));
        '</div>' +
      '</div>';
    }

    if (tab === 'orders') {
      var orders = S.orders().filter(function (o) { return o.elderId === elder.id; }).slice(0, 5);
      return '<div class="card">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('clipboard') + '服务记录</div>' +
          '<span class="card-sub">上门关怀 · 陪诊 · 康复护理</span></div>' +
        '<div class="card-body">' +
          (orders.length ? '<div class="family-order-list">' + orders.map(function (o) {
            return '<div class="family-order">' +
              '<div class="family-order-head"><b>' + D.DICT.orderType[o.type].text + '</b>' +
                UI.statusTag(D.DICT.orderStatus, o.status) + '</div>' +
              '<p class="t3 t-sm">预约时间 ' + U.fmtDate(o.appointAt, 'YYYY-MM-DD HH:mm') + ' · 服务人 ' + U.esc(o.owner) + '</p>' +
              (o.summary ? '<p class="family-order-summary">' + U.esc(o.summary) + '</p>' : '') +
              (o.rating ? '<div class="family-order-rating">' + stars(o.rating) + '<span>' + o.rating + '.0 分</span></div>' : '') +
            '</div>';
          }).join('') + '</div>' :
            UI.empty('clipboard', '暂无服务记录', '村居社工将按套餐定期上门关怀。'));
        '</div>' +
      '</div>';
    }

    if (tab === 'device') {
      /* 已绑定老人但未绑定设备：渲染空态，避免访问 device 字段报错 */
      if (!device) {
        return UI.empty('watch', '暂未绑定设备', '该老人暂未绑定智能手环，绑定后即可查看设备状态与电量。');
      }
      var battery = device.battery;
      /* 老人个人号码不展示明文，仅管理员放行；SOS 热线始终明文 */
      var raw = U.canSeeRaw();
      return '<div class="family-device-grid">' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">' + YL.icon('watch') + '手环状态</div>' +
            '<span class="status online"><span class="dot"></span>在线</span></div>' +
          '<div class="card-body">' +
            '<div class="family-device-visual">' +
              '<div class="device-illustration">' + YL.icon('watch') + '</div>' +
              '<div class="family-device-meta">' +
                '<b class="mono">' + U.esc(device.id) + '</b>' +
                '<span>' + U.esc(device.type) + '</span>' +
                '<em>固件 ' + U.esc(device.firmware) + '</em>' +
              '</div>' +
            '</div>' +
            '<div class="divider"></div>' +
            '<div class="family-battery">' +
              '<div><span>剩余电量</span><b class="num">' + battery + '%</b></div>' +
              '<div class="bar ' + (battery < 20 ? 'red' : battery < 45 ? 'orange' : 'green') + '" style="height:8px"><i style="width:' + battery + '%"></i></div>' +
              '<p class="t-xs t3">建议电量低于 20% 时提醒老人充电，充电约 90 分钟可充满。</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">' + YL.icon('phone') + '紧急联系</div></div>' +
          '<div class="card-body">' +
            '<div class="family-sos">' +
              '<b class="num">' + (raw ? U.esc(elder.phone) : U.maskPhone(elder.phone)) + '</b>' +
              '<span>长按手环侧键 3 秒自动拨打</span>' +
              (raw ? '<button type="button" class="btn btn-soft" data-call-family>' + YL.icon('phone') + '拨打家属电话</button>' : '') +
            '</div>' +
            '<div class="divider"></div>' +
            '<dl class="kv-list">' +
              '<div><span class="k">责任社工</span><span class="v">' + U.esc(elder.volunteer) + '</span></div>' +
              '<div><span class="k">所属村居</span><span class="v">' + U.esc(elder.village) + '</span></div>' +
              '<div><span class="k">SOS 号码</span><span class="v num">' + U.esc(S.state.thresholds.sosNumber) + '</span></div>' +
              '<div><span class="k">电子围栏</span><span class="v">' + S.state.thresholds.fenceRadius + ' 米</span></div>' +
            '</dl>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    /* 今日概况 */
    var records = D.serviceRecords(elder).slice(0, 3);
    var alerts = S.alerts().filter(function (a) { return a.elderId === elder.id; }).slice(0, 2);
    return '<div class="family-overview">' +
      '<div class="card">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('activity') + '近 7 天体征趋势</div>' +
          '<span class="card-sub">心率 / 血压 / 血氧</span></div>' +
        '<div class="card-body"><div class="chart" id="chFamilyTrend" style="height:300px"></div></div>' +
      '</div>' +
      '<div class="family-side">' +
        '<div class="card family-ai">' +
          '<div class="family-ai-head"><span>' + YL.icon('spark') + '</span><b>AI 健康提示</b><i>盘古大模型</i></div>' +
          '<p>近 7 天血压波动较明显，建议每日早晚固定时间测量；饮食注意控盐，若出现头晕请及时联系家庭医生。</p>' +
          '<a class="btn btn-sm btn-soft" href="#/family?tab=vitals">查看体征档案</a>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">' + YL.icon('clipboard') + '最近服务</div></div>' +
          '<div class="card-body">' +
            '<div class="timeline">' + records.map(function (r, i) {
              return '<div class="tl-item ' + (i === 0 ? 'done' : '') + '">' +
                '<div class="tl-head"><span class="tl-title">' + U.esc(r.type) + '</span>' +
                  '<span class="tl-time">' + U.fmtDate(r.time, 'MM-DD') + '</span></div>' +
                '<div class="tl-desc">' + U.esc(r.note) + '</div></div>';
            }).join('') + '</div>' +
            (alerts.length ? '<div class="divider"></div><div class="family-mini-alert">' +
              YL.icon('alert') + '<span>' + D.DICT.alertType[alerts[0].type].text + ' · ' + U.relTime(alerts[0].time) + '</span>' +
              '<a href="#/family?tab=alerts" class="btn-link">查看</a></div>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function stars(n) {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<span class="star' + (i <= n ? ' on' : '') + '">' + YL.icon('star') + '</span>';
    }
    return '<span class="stars">' + html + '</span>';
  }

  function mountCharts(container, tab, elder) {
    var series = D.vitalSeries(elder, 30);
    if (tab === 'overview') {
      var chart = container.querySelector('#chFamilyTrend');
      if (chart) {
        C.mount(chart, C.vitalTrendOption(D.TREND7.labels, [
          { name: '心率 (bpm)', data: D.TREND7.hr, color: '#165DFF', area: true },
          { name: '收缩压 (mmHg)', data: D.TREND7.sbp, color: '#FF7D00' },
          { name: '血氧 (%)', data: D.TREND7.spo2, color: '#00B42A', axis: 1, dashed: true }
        ]));
      }
    }
    if (tab === 'vitals') {
      var c1 = container.querySelector('#chFamilyVital');
      if (c1) {
        C.mount(c1, C.vitalTrendOption(series.labels, [
          { name: '心率 (bpm)', data: series.hr, color: '#165DFF', area: true },
          { name: '收缩压 (mmHg)', data: series.sbp, color: '#FF7D00' },
          { name: '舒张压 (mmHg)', data: series.dbp, color: '#94BFFF', dashed: true }
        ]));
      }
      var c2 = container.querySelector('#chFamilySpo2');
      if (c2) C.mount(c2, C.areaOption(series.labels, series.spo2, { min: 88, color: '#00B42A' }));
    }
  }

  function bind(container, route) {
    container.querySelectorAll('.family-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var tab = b.getAttribute('data-tab');
        YL.router.go('/family' + (tab === 'overview' ? '' : '?tab=' + tab));
      });
    });
    var callBtn = container.querySelector('[data-call-family]');
    if (callBtn) {
      callBtn.addEventListener('click', function () {
        /* 家属视图不提供完整号码，按钮默认不渲染，此处兜底 */
        if (!U.canSeeRaw()) {
          UI.toast('为保护隐私，家属视图不展示完整号码', 'info');
          return;
        }
        var elder = myElder();
        if (!elder) return;
        UI.phoneModal(elder.phone, elder.familyName, elder.relation);
      });
    }
  }

  YL.pages = YL.pages || {};
  YL.pages.family = { render: render };
})(window);