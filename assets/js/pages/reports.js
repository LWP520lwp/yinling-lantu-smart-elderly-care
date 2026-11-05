/* ==========================================================================
   页面 7：数据统计报表（含民政上报制式报表）
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;
  var C = YL.charts;

  var state = { range: 'month', page: 1, size: 6 };

  /** 操作审计：后端不可用或 api 未就绪时静默跳过，不阻塞页面 */
  function auditLog(action, payload) {
    if (!YL.api || typeof YL.api.audit !== 'function') return;
    try {
      YL.api.audit(action, payload);
    } catch (e) {
      /* 审计失败不影响页面主流程 */
    }
  }

  /** 报表导出审计：type 区分导出类型（coverage 统计报表 / gov 民政上报报表） */
  function auditReportExport(type, count) {
    auditLog('report_export', {
      target_type: 'report',
      target_id: type,
      result: 'ok',
      detail: { count: count }
    });
  }

  var RANGE_FACTOR = { day: .028, week: .17, month: 1, quarter: 2.92 };
  var RANGE_LABEL = { day: '今日', week: '本周', month: '本月', quarter: '本季度' };
  var RANGE_PERIOD = {
    day: function () { return U.fmtDate(new Date(), 'YYYY-MM-DD'); },
    week: function () { return '第 ' + Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 604800000) + ' 周'; },
    month: function () { return U.fmtDate(new Date(), 'YYYY 年 MM 月'); },
    quarter: function () { return U.fmtDate(new Date(), 'YYYY 年') + ' 第 ' + (Math.floor(new Date().getMonth() / 3) + 1) + ' 季度'; }
  };

  function townsRows() {
    var map = {};
    D.VILLAGES.forEach(function (v) {
      if (!map[v.town]) map[v.town] = { town: v.town, villages: 0, total: 0, registered: 0, orders: 0 };
      map[v.town].villages++;
      map[v.town].total += v.total;
      map[v.town].registered += v.registered;
      map[v.town].orders += Math.round(v.total * 1.6);
    });
    return Object.keys(map).map(function (k) {
      var r = map[k];
      r.rate = r.total / r.registered * 100;
      return r;
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function render(container, route) {
    var f = RANGE_FACTOR[state.range];
    var served = Math.round(1204 * f);
    var doneRate = 96.4;

    container.innerHTML =
      '<div class="page page-reports">' +
        '<div class="page-head">' +
          '<div><h2>数据统计报表</h2>' +
            '<p>面向民政部门与机构管理者的区域养老数据看板，支持按周期汇总与制式报表上报。</p></div>' +
          '<div class="page-actions">' +
            '<button type="button" class="btn btn-outline" id="exportReport">' + YL.icon('download') + '导出 Excel</button>' +
            /* 完整档案为明文个人信息，仅管理员可见 */
            (U.canSeeRaw() ? '<button type="button" class="btn btn-outline" id="exportArchive">' + YL.icon('download') + '导出完整档案</button>' : '') +
            '<button type="button" class="btn btn-primary" id="govReport">' + YL.icon('file-text') + '生成民政上报报表</button>' +
          '</div>' +
        '</div>' +

        '<div class="report-toolbar">' +
          '<div class="segmented" id="rangeSwitch">' +
            Object.keys(RANGE_LABEL).map(function (k) {
              return '<button type="button" class="' + (state.range === k ? 'active' : '') + '" data-range="' + k + '">' + RANGE_LABEL[k] + '</button>';
            }).join('') +
          '</div>' +
          '<div class="report-period">' + YL.icon('calendar') +
            '<span>统计周期：<b id="periodLabel">' + RANGE_PERIOD[state.range]() + '</b></span>' +
            '<span class="text-divider">|</span>' +
            '<span>数据更新于 <b>' + U.fmtDate(D.NOW, 'YYYY-MM-DD HH:mm') + '</b></span>' +
          '</div>' +
          '<div class="ml-auto t-xs t3">数据口径：平潭综合实验区民政局养老服务指导中心</div>' +
        '</div>' +

        '<div class="metrics metrics-4">' +
          '<div class="metric is-brand"><div class="metric-label">养老服务覆盖率</div>' +
            '<div class="metric-value">84.3<span class="unit">%</span></div>' +
            '<div class="metric-foot">较上期 <span class="delta-up">+2.1%</span></div></div>' +
          '<div class="metric is-orange"><div class="metric-label">' + RANGE_LABEL[state.range] + '服务人次</div>' +
            '<div class="metric-value" id="kpiServed">' + U.fmt(served) + '<span class="unit">人次</span></div>' +
            '<div class="metric-foot">上门 / 陪诊 / 护理 / 家政</div></div>' +
          '<div class="metric is-green"><div class="metric-label">工单完成率</div>' +
            '<div class="metric-value">' + doneRate + '<span class="unit">%</span></div>' +
            '<div class="metric-foot">平均响应 8.6 分钟</div></div>' +
          '<div class="metric"><div class="metric-label">设备在线率</div>' +
            '<div class="metric-value">91.7<span class="unit">%</span></div>' +
            '<div class="metric-foot">告警准确率 93.8%</div></div>' +
        '</div>' +

        '<div class="report-grid">' +

          /* 覆盖率 */
          '<article class="card report-card span-2">' +
            '<div class="card-head">' +
              '<div class="card-title">' + YL.icon('map-pin') + '养老服务覆盖率报表<span class="card-sub">按村居</span></div>' +
              '<div class="card-extra"><span class="pill pill-brand">42 个合作村居</span></div>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="coverage-layout">' +
                '<div class="chart" id="chCoverage" style="height:198px"></div>' +
                '<div class="coverage-table" id="coverageTable"></div>' +
              '</div>' +
            '</div>' +
          '</article>' +

          /* 健康趋势 */
          '<article class="card report-card">' +
            '<div class="card-head">' +
              '<div class="card-title">' + YL.icon('heart') + '健康趋势报表</div>' +
              '<span class="card-sub">区域老人慢病占比</span>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="chart" id="chChronic" style="height:176px"></div>' +
              '<div class="divider"></div>' +
              '<div class="health-kpi-grid">' +
                '<div><span>平均心率</span><b class="num">79</b><em>bpm</em></div>' +
                '<div><span>平均血压</span><b class="num">136/84</b><em>mmHg</em></div>' +
                '<div><span>平均血氧</span><b class="num">95.9</b><em>%</em></div>' +
                '<div><span>异常体征老人</span><b class="num">43</b><em>人</em></div>' +
              '</div>' +
            '</div>' +
          '</article>' +

          /* 服务效能 */
          '<article class="card report-card">' +
            '<div class="card-head">' +
              '<div class="card-title">' + YL.icon('trend-up') + '服务效能报表</div>' +
              '<span class="card-sub">近 6 周</span>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="chart" id="chEfficiency" style="height:186px"></div>' +
              '<div class="divider"></div>' +
              '<div class="mini-kv"><span>工单完成率</span><b class="num">96.4%</b></div>' +
              '<div class="mini-kv"><span>平均响应时长</span><b class="num">8.6 分钟</b></div>' +
              '<div class="mini-kv"><span>志愿者累计服务</span><b class="num">18,420 小时</b></div>' +
            '</div>' +
          '</article>' +

          /* 设备运营 */
          '<article class="card report-card span-2">' +
            '<div class="card-head">' +
              '<div class="card-title">' + YL.icon('watch') + '设备运营报表</div>' +
              '<div class="card-extra"><button type="button" class="btn-link" id="deviceDetail">查看设备明细</button></div>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="device-ops-layout">' +
                '<div>' +
                  '<div class="vital-chart-label"><span>近 7 天设备在线率</span><em>目标值 95%</em></div>' +
                  '<div class="chart" id="chDeviceRate" style="height:170px"></div>' +
                '</div>' +
                '<div class="device-ops-kpis">' +
                  '<div class="ops-kpi"><span>设备在线率</span><b class="num">91.7%</b><div class="bar green"><i style="width:91.7%"></i></div></div>' +
                  '<div class="ops-kpi"><span>告警准确率</span><b class="num">93.8%</b><div class="bar"><i style="width:93.8%"></i></div></div>' +
                  '<div class="ops-kpi"><span>故障设备</span><b class="num">25 台</b><div class="bar red"><i style="width:26%"></i></div></div>' +
                  '<div class="ops-kpi"><span>日均数据上报</span><b class="num">186.4 万</b><div class="bar orange"><i style="width:78%"></i></div></div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</article>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderCoverageTable(container);
    mountCharts(container);
    bind(container);
  }

  function renderCoverageTable(container) {
    var rows = D.VILLAGES.slice().sort(function (a, b) { return b.rate - a.rate; });
    var pages = Math.max(1, Math.ceil(rows.length / state.size));
    if (state.page > pages) state.page = pages;
    var pageRows = rows.slice((state.page - 1) * state.size, state.page * state.size);

    container.querySelector('#coverageTable').innerHTML =
      '<table class="tbl tbl-sm coverage-tbl">' +
        '<thead><tr><th>村居</th><th>在册</th><th>服务</th><th>覆盖率</th><th>状态</th></tr></thead>' +
        '<tbody>' + pageRows.map(function (v) {
          var tone = v.rate >= 90 ? 'tag-green' : v.rate >= 75 ? 'tag-brand' : 'tag-orange';
          return '<tr>' +
            '<td><div class="cell-strong">' + U.esc(v.name) + '</div><div class="t-xs t3">' + U.esc(v.town) + '</div></td>' +
            '<td class="cell-num">' + v.registered + '</td>' +
            '<td class="cell-num">' + v.total + '</td>' +
            '<td><div class="rate-cell"><b class="num">' + v.rate.toFixed(1) + '%</b><div class="bar"><i style="width:' + v.rate + '%"></i></div></div></td>' +
            '<td><span class="tag ' + tone + '">' + (v.rate >= 90 ? '达标' : v.rate >= 75 ? '基本达标' : '待提升') + '</span></td>' +
          '</tr>';
        }).join('') + '</tbody>' +
      '</table>' +
      '<div class="coverage-foot">' +
        '<span class="t-xs t3">共 ' + rows.length + ' 个村居</span>' +
        '<div class="page-list">' +
          '<button type="button" class="page-btn" data-cov-page="' + (state.page - 1) + '"' + (state.page <= 1 ? ' disabled' : '') + '>' + YL.icon('arrow-left') + '</button>' +
          '<span class="t-xs t3 num">' + state.page + ' / ' + pages + '</span>' +
          '<button type="button" class="page-btn" data-cov-page="' + (state.page + 1) + '"' + (state.page >= pages ? ' disabled' : '') + '>' + YL.icon('arrow-right') + '</button>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container.querySelector('#coverageTable'));
    container.querySelectorAll('[data-cov-page]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = Number(b.getAttribute('data-cov-page'));
        if (p < 1 || p > pages) return;
        state.page = p;
        renderCoverageTable(container);
      });
    });
  }

  function mountCharts(container) {
    var top = D.VILLAGES.slice().sort(function (a, b) { return b.rate - a.rate; }).slice(0, 8);
    C.mount(container.querySelector('#chCoverage'), C.hBarOption(
      top.map(function (v) {
        return { name: v.name, value: v.rate, color: v.rate >= 90 ? '#165DFF' : v.rate >= 75 ? '#7BA8FF' : '#FF7D00' };
      }),
      { max: 100, digits: 1, suffix: '%' }
    ));

    C.mount(container.querySelector('#chChronic'), C.hBarOption(
      D.SUMMARY.chronic.map(function (c, i) {
        return { name: c.name, value: c.value, color: ['#F53F3F', '#FF7D00', '#165DFF', '#00B42A', '#00A6C0', '#A9B0BC'][i] };
      }),
      { digits: 1, suffix: '%' }
    ));

    C.mount(container.querySelector('#chEfficiency'), C.efficiencyOption(
      D.EFFICIENCY.labels, D.EFFICIENCY.completion, D.EFFICIENCY.response
    ));

    C.mount(container.querySelector('#chDeviceRate'), C.areaOption(
      D.DEVICE_RATE7.labels, D.DEVICE_RATE7.values, { min: 88, color: '#165DDF' }
    ));
  }

  function bind(container) {
    container.querySelectorAll('#rangeSwitch [data-range]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.range = b.getAttribute('data-range');
        container.querySelectorAll('#rangeSwitch button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var f = RANGE_FACTOR[state.range];
        container.querySelector('#periodLabel').textContent = RANGE_PERIOD[state.range]();
        var kpi = container.querySelector('#kpiServed');
        U.countUp(kpi, Math.round(1204 * f), { duration: 500 });
        UI.toast('已切换至「' + RANGE_LABEL[state.range] + '」统计口径', 'info', 1800);
      });
    });

    container.querySelector('#exportReport').addEventListener('click', function () {
      var headers = ['村居', '所属乡镇', '在册老人', '服务老人', '覆盖率(%)', '本月工单数', '达标情况'];
      var rows = D.VILLAGES.slice().sort(function (a, b) { return b.rate - a.rate; }).map(function (v) {
        return [v.name, v.town, v.registered, v.total, v.rate.toFixed(1), Math.round(v.total * 1.6), v.rate >= 90 ? '达标' : v.rate >= 75 ? '基本达标' : '待提升'];
      });
      U.download('银龄岚途_养老服务统计报表_' + U.fmtDate(new Date(), 'YYYYMMDD') + '.csv', U.toCSV(headers, rows));
      auditReportExport('coverage', rows.length);
      UI.toast('报表已导出，可用 Excel 打开', 'success');
    });

    /* 非管理员不渲染该按钮，需判空 */
    var archiveBtn = container.querySelector('#exportArchive');
    if (archiveBtn) archiveBtn.addEventListener('click', openArchiveConfirm);

    container.querySelector('#govReport').addEventListener('click', openGovReport);
    container.querySelector('#deviceDetail').addEventListener('click', function () { YL.router.go('/devices'); });
  }

  /* ------------------------------------------------------------------
     完整档案导出（明文个人信息，需二次确认）
     ------------------------------------------------------------------ */
  function openArchiveConfirm() {
    UI.modal({
      size: 'sm',
      title: '导出完整档案',
      body:
        '<p class="t-sm t3">该文件包含老人真实姓名、联系电话、住址等个人信息，仅限授权场景使用。' +
        '请确认已获得相应授权，导出后妥善保管，不得随意外传。</p>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-confirm>确认导出（明文）</button>',
      onMount: function (api, overlay) {
        overlay.querySelector('[data-confirm]').addEventListener('click', function () {
          api.close();
          var elders = YL.pages && YL.pages.elders;
          if (!elders || typeof elders.exportArchive !== 'function') {
            UI.toast('档案导出模块未加载', 'error');
            return;
          }
          elders.exportArchive();
          UI.toast('完整档案已导出，请注意文件保管', 'success');
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     民政上报制式报表
     ------------------------------------------------------------------ */
  function openGovReport() {
    var rows = townsRows();
    var totalRegistered = rows.reduce(function (s, r) { return s + r.registered; }, 0);
    var totalServed = rows.reduce(function (s, r) { return s + r.total; }, 0);
    var totalOrders = rows.reduce(function (s, r) { return s + r.orders; }, 0);

    UI.modal({
      size: 'lg',
      title: '民政上报制式报表',
      desc: '按民政部门养老服务统计口径自动汇总，可打印盖章后上报。',
      body:
        '<div class="gov-report" id="govReportBody">' +
          '<div class="gov-title">平潭综合实验区养老服务统计报表</div>' +
          '<div class="gov-subtitle">统计周期：' + RANGE_PERIOD[state.range]() + ' · 填报单位：平潭综合实验区民政局养老服务指导中心</div>' +
          '<div class="gov-meta">' +
            '<span>制表人：林晓岚</span><span>审核人：陈志远</span><span>制表日期：' + U.fmtDate(new Date(), 'YYYY-MM-DD') + '</span>' +
          '</div>' +
          '<table class="tbl gov-tbl">' +
            '<thead><tr><th>乡镇</th><th>村居数</th><th>在册老人</th><th>服务老人</th><th>覆盖率</th><th>服务工单</th><th>备注</th></tr></thead>' +
            '<tbody>' +
              rows.map(function (r) {
                return '<tr>' +
                  '<td>' + U.esc(r.town) + '</td><td class="cell-num">' + r.villages + '</td>' +
                  '<td class="cell-num">' + r.registered + '</td><td class="cell-num">' + r.total + '</td>' +
                  '<td class="cell-num">' + r.rate.toFixed(1) + '%</td><td class="cell-num">' + r.orders + '</td>' +
                  '<td>' + (r.rate >= 90 ? '达标' : '待提升') + '</td>' +
                '</tr>';
              }).join('') +
              '<tr class="gov-total"><td>合计</td><td class="cell-num">42</td><td class="cell-num">' + U.fmt(totalRegistered) + '</td>' +
                '<td class="cell-num">' + U.fmt(totalServed) + '</td><td class="cell-num">84.3%</td>' +
                '<td class="cell-num">' + U.fmt(totalOrders) + '</td><td>—</td></tr>' +
            '</tbody>' +
          '</table>' +
          '<div class="gov-sign">' +
            '<div>单位负责人（签字）：____________________</div>' +
            '<div>填报单位（盖章）：____________________</div>' +
            '<div>日期：' + U.fmtDate(new Date(), 'YYYY 年 MM 月 DD 日') + '</div>' +
          '</div>' +
          '<p class="gov-note">注：本表数据由银龄岚途乡村智慧养老综合管理平台自动生成，设备数据经华为云 IoT 设备接入平台校验。</p>' +
        '</div>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>关闭</button>' +
        '<button type="button" class="btn btn-outline" data-gov-export>' + YL.icon('download') + '导出报表</button>' +
        '<button type="button" class="btn btn-primary" data-gov-print>' + YL.icon('file-text') + '打印 / 另存 PDF</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelector('[data-gov-export]').addEventListener('click', function () {
          var headers = ['乡镇', '村居数', '在册老人', '服务老人', '覆盖率(%)', '服务工单', '备注'];
          var data = rows.map(function (r) {
            return [r.town, r.villages, r.registered, r.total, r.rate.toFixed(1), r.orders, r.rate >= 90 ? '达标' : '待提升'];
          });
          // 先记录真实数据行数再追加合计行，避免审计条数被合计行虚增
          var rowCount = data.length;
          data.push(['合计', 42, totalRegistered, totalServed, '84.3', totalOrders, '—']);
          U.download('平潭综合实验区养老服务统计报表_' + U.fmtDate(new Date(), 'YYYYMMDD') + '.csv', U.toCSV(headers, data));
          auditReportExport('gov', rowCount);
          UI.toast('民政上报报表已导出', 'success');
        });
        overlay.querySelector('[data-gov-print]').addEventListener('click', function () {
          UI.toast('正在调起打印预览，请选择「另存为 PDF」', 'info');
          document.body.classList.add('print-gov');
          setTimeout(function () {
            window.print();
            document.body.classList.remove('print-gov');
          }, 500);
        });
      }
    });
  }

  YL.pages = YL.pages || {};
  YL.pages.reports = { render: render };
})(window);