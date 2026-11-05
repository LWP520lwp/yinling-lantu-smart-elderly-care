/* ==========================================================================
   页面 5：应急告警中心（处置闭环）
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;

  var state = { tab: 'all', type: '', page: 1, size: 8, q: '' };

  var TABS = [
    { key: 'all', label: '全部告警' },
    { key: 'pending', label: '未处理' },
    { key: 'done', label: '已处置' },
    { key: 'false', label: '误报' }
  ];

  function priority(a) {
    var score = 0;
    if (a.status === 'pending') score += 3;
    if (a.status === 'doing') score += 2;
    if (a.level === 'critical') score += 1;
    return score;
  }

  function filtered() {
    return S.alerts().filter(function (a) {
      if (state.tab !== 'all') {
        if (state.tab === 'pending' && a.status !== 'pending') return false;
        if (state.tab === 'done' && a.status !== 'done' && a.status !== 'doing') return false;
        if (state.tab === 'false' && a.status !== 'false') return false;
      }
      if (state.type && a.type !== state.type) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (a.elderName.toLowerCase().indexOf(q) === -1 && a.village.toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function (a, b) {
      var diff = priority(b) - priority(a);
      return diff !== 0 ? diff : b.time - a.time;
    });
  }

  /* ------------------------------------------------------------------
     页面
     ------------------------------------------------------------------ */
  function render(container, route) {
    var s = D.SUMMARY;
    var list = S.alerts();
    var pending = list.filter(function (a) { return a.status === 'pending'; }).length;
    var done = list.filter(function (a) { return a.status === 'done'; }).length;
    var falseCount = list.filter(function (a) { return a.status === 'false'; }).length;

    container.innerHTML =
      '<div class="page page-alerts">' +
        '<div class="page-head">' +
          '<div><h2>应急告警中心</h2>' +
            '<p>手环跌倒检测、体征异常与电子围栏告警统一受理，形成「告警 — 派单 — 处置 — 回访」闭环。</p></div>' +
          '<div class="page-actions">' +
            '<span class="pill pill-red live-pill"><span class="live-dot"></span>实时接收中</span>' +
            '<button type="button" class="btn btn-outline" id="exportAlerts">' + YL.icon('download') + '导出告警台账</button>' +
          '</div>' +
        '</div>' +

        '<div class="metrics metrics-4">' +
          '<div class="metric is-red"><div class="metric-label">' + YL.icon('alert') + '今日告警总数</div>' +
            '<div class="metric-value">' + s.todayAlerts + '<span class="unit">条</span></div>' +
            '<div class="metric-foot">较昨日 <span class="delta-down">-3 条</span></div></div>' +
          '<div class="metric is-orange"><div class="metric-label">未处理告警</div>' +
            '<div class="metric-value">' + pending + '<span class="unit">条</span></div>' +
            '<div class="metric-foot">' + (pending ? '需在 15 分钟内响应' : '全部处置完毕') + '</div></div>' +
          '<div class="metric is-green"><div class="metric-label">今日已处置</div>' +
            '<div class="metric-value">' + s.alertDone + '<span class="unit">条</span></div>' +
            '<div class="metric-foot">平均响应 8.6 分钟</div></div>' +
          '<div class="metric"><div class="metric-label">今日误报</div>' +
            '<div class="metric-value">' + s.alertFalse + '<span class="unit">条</span></div>' +
            '<div class="metric-foot">设备误报率 6.2%</div></div>' +
        '</div>' +

        '<div class="alert-layout">' +
          '<div class="card alert-table-card">' +
            '<div class="alert-tabs">' +
              '<div class="tabs" id="alertTabs">' +
                TABS.map(function (t) {
                  var count = t.key === 'all' ? list.length :
                    t.key === 'pending' ? pending :
                      t.key === 'done' ? done : falseCount;
                  return '<button type="button" class="tab' + (state.tab === t.key ? ' active' : '') + '" data-tab="' + t.key + '">' +
                    t.label + '<span class="count">' + count + '</span></button>';
                }).join('') +
              '</div>' +
              '<div class="alert-tools">' +
                '<div class="input-wrap" style="width:210px">' +
                  '<span class="input-ico" data-icon="search"></span>' +
                  '<input id="alertSearch" placeholder="老人姓名 / 村居" value="' + U.esc(state.q) + '">' +
                '</div>' +
                '<div class="input-wrap select-wrap" style="width:150px">' +
                  '<select id="alertTypeFilter">' +
                    '<option value="">全部类型</option>' +
                    Object.keys(D.DICT.alertType).map(function (k) {
                      return '<option value="' + k + '"' + (state.type === k ? ' selected' : '') + '>' + D.DICT.alertType[k].text + '</option>';
                    }).join('') +
                  '</select><span class="select-caret" data-icon="chevron"></span>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="table-wrap" id="alertTable"></div>' +
            '<div id="alertPager"></div>' +
          '</div>' +

          '<aside class="alert-side">' +
            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('chart') + '告警类型分布</div>' +
                '<span class="card-sub">今日</span></div>' +
              '<div class="card-body">' +
                Object.keys(D.DICT.alertType).map(function (k) {
                  var v = s.alertTypes[k] || 0;
                  var total = s.todayAlerts;
                  return '<div class="type-row">' +
                    '<div class="type-row-head"><span>' + D.DICT.alertType[k].text + '</span><b class="num">' + v + '</b></div>' +
                    '<div class="bar ' + (k === 'fall' ? 'red' : k === 'spo2' ? 'orange' : '') + '"><i style="width:' + (v / total * 100) + '%"></i></div>' +
                  '</div>';
                }).join('') +
                '<div class="divider"></div>' +
                '<div class="alert-peak">' + YL.icon('clock') +
                  '<span>今日告警高峰 <b>19:00 - 21:00</b>，建议加强夜间值班力量</span></div>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('clock') + '处置时效</div></div>' +
              '<div class="card-body">' +
                '<div class="sla-grid">' +
                  '<div><b class="num">8.6</b><span>平均响应（分钟）</span></div>' +
                  '<div><b class="num">94.1%</b><span>30 分钟内处置率</span></div>' +
                  '<div><b class="num">100%</b><span>紧急告警闭环率</span></div>' +
                  '<div><b class="num">6.2%</b><span>设备误报率</span></div>' +
                '</div>' +
                '<div class="info-note mt-3">' + YL.icon('info') +
                  '<span>跌倒检测采用三轴加速度突变 + 心率异常双因子校验，需 30 秒内未取消才上报，降低误报。</span></div>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('users') + '今日值班社工</div></div>' +
              '<div class="card-body duty-list">' +
                [
                  ['蔡文静', '流水镇', 'online', '08:00 - 20:00'],
                  ['念晓东', '北厝镇', 'online', '08:00 - 20:00'],
                  ['施小燕', '澳前镇', 'warn', '外出随访中']
                ].map(function (row) {
                  return '<div class="duty-row">' +
                    '<span class="avatar avatar-sm x-slate">' + row[0].slice(0, 1) + '</span>' +
                    '<div><b>' + row[0] + '</b><em>' + row[1] + ' · ' + row[3] + '</em></div>' +
                    '<span class="status ' + row[2] + '"><span class="dot"></span>' + (row[2] === 'online' ? '在线' : '随访中') + '</span>' +
                  '</div>';
                }).join('') +
              '</div>' +
            '</article>' +
          '</aside>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderTable(container);
    bind(container);

    if (route && route.query && route.query.focus) {
      setTimeout(function () { openAlert(route.query.focus, 'handle'); }, 260);
    }
  }

  function renderTable(container) {
    var all = filtered();
    var pages = Math.max(1, Math.ceil(all.length / state.size));
    if (state.page > pages) state.page = pages;
    var rows = all.slice((state.page - 1) * state.size, state.page * state.size);
    var table = container.querySelector('#alertTable');

    if (!all.length) {
      table.innerHTML = UI.empty('shield', '当前没有该类告警', '设备运行平稳，可切换其他分类查看历史告警记录。');
      container.querySelector('#alertPager').innerHTML = '';
      return;
    }

    table.innerHTML =
      '<table class="tbl">' +
        '<thead><tr>' +
          '<th>告警时间</th><th>老人</th><th>告警类型</th><th>所属村居</th>' +
          '<th>等级</th><th>处理状态</th><th>处理人</th><th class="col-actions">操作</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (a) {
          var critical = a.level === 'critical';
          var highlight = critical && a.status === 'pending';
          var type = D.DICT.alertType[a.type];
          return '<tr class="' + (highlight ? 'row-critical' : '') + '">' +
            '<td><span class="t-sm">' + U.fmtDate(a.time, 'MM-DD HH:mm') + '</span>' +
              '<div class="t-xs t3">' + U.relTime(a.time) + '</div></td>' +
            '<td>' +
              '<div class="person"><span class="avatar avatar-sm ' + (critical ? 'x-warm' : '') + '">' + U.esc(a.elderName.slice(0, 1)) + '</span>' +
                '<div class="person-info"><span class="person-name">' + U.esc(a.elderName) + '</span>' +
                  '<span class="person-meta">' + a.elderAge + ' 岁 · ' + U.esc(a.village) + '</span></div></div>' +
            '</td>' +
            '<td><span class="alert-type-cell">' + YL.icon(type.icon) + type.text + '</span>' +
              '<div class="t-xs t3">' + U.esc(a.metric) + '</div></td>' +
            '<td><span class="t-sm">' + U.esc(a.village) + '</span><div class="t-xs t3">' + U.esc(a.town) + '</div></td>' +
            '<td>' + UI.statusTag(D.DICT.alertLevel, a.level) + '</td>' +
            '<td>' + UI.statusTag(D.DICT.alertStatus, a.status) + '</td>' +
            '<td><span class="t-sm">' + (a.handler || '—') + '</span>' +
              (a.handleWay ? '<div class="t-xs t3">' + U.esc(a.handleWay) + '</div>' : '') + '</td>' +
            '<td class="col-actions">' +
              (a.status === 'pending' || a.status === 'doing' ?
                '<button type="button" class="btn btn-sm btn-primary" data-handle="' + a.id + '">立即处置</button>' :
                '<button type="button" class="btn-link" data-view-alert="' + a.id + '">处置记录</button>') +
              '<button type="button" class="btn-link" data-call="' + a.id + '" title="拨打紧急联系人">拨号</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';

    container.querySelector('#alertPager').innerHTML = UI.pager({ total: all.length, page: state.page, size: state.size });
    YL.hydrateIcons(table);

    table.querySelectorAll('[data-handle]').forEach(function (b) {
      b.addEventListener('click', function () { openAlert(b.getAttribute('data-handle'), 'handle'); });
    });
    table.querySelectorAll('[data-view-alert]').forEach(function (b) {
      b.addEventListener('click', function () { openAlert(b.getAttribute('data-view-alert'), 'view'); });
    });
    table.querySelectorAll('[data-call]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = findAlert(b.getAttribute('data-call'));
        if (a) UI.phoneModal(a.phone, a.familyName, a.relation);
      });
    });

    UI.bindPager(container.querySelector('#alertPager'), function (page, size) {
      if (size) state.size = size;
      state.page = page;
      renderTable(container);
    });
  }

  function bind(container) {
    container.querySelectorAll('#alertTabs [data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        container.querySelectorAll('#alertTabs .tab').forEach(function (t) { t.classList.remove('active'); });
        b.classList.add('active');
        state.tab = b.getAttribute('data-tab');
        state.page = 1;
        renderTable(container);
      });
    });

    var search = container.querySelector('#alertSearch');
    search.addEventListener('input', U.debounce(function () {
      state.q = search.value.trim();
      state.page = 1;
      renderTable(container);
    }, 260));

    container.querySelector('#alertTypeFilter').addEventListener('change', function () {
      state.type = this.value;
      state.page = 1;
      renderTable(container);
    });

    container.querySelector('#exportAlerts').addEventListener('click', function () {
      var list = filtered();
      var headers = ['告警编号', '告警时间', '老人姓名', '年龄', '告警类型', '所属村居', '等级', '处理状态', '处理人', '处理方式', '处理结果'];
      var rows = list.map(function (a) {
        return [a.id, U.fmtDate(a.time, 'YYYY-MM-DD HH:mm'), a.elderName, a.elderAge,
          D.DICT.alertType[a.type].text, a.village, D.DICT.alertLevel[a.level].text,
          D.DICT.alertStatus[a.status].text, a.handler || '—', a.handleWay || '—', a.result || '—'];
      });
      U.download('银龄岚途_告警处置台账_' + U.fmtDate(new Date(), 'YYYYMMDD') + '.csv', U.toCSV(headers, rows));
      UI.toast('已导出 ' + list.length + ' 条告警记录', 'success');
    });
  }

  function findAlert(id) {
    return S.alerts().filter(function (a) { return a.id === id; })[0];
  }

  /* ------------------------------------------------------------------
     处置弹窗
     ------------------------------------------------------------------ */
  function openAlert(id, mode) {
    var a = findAlert(id);
    if (!a) { UI.toast('告警记录不存在或已被移除', 'warn'); return; }
    var type = D.DICT.alertType[a.type];
    var isView = mode === 'view' || a.status === 'done' || a.status === 'false';

    var wayOptions = [
      { key: '联系家属', icon: 'phone', desc: '电话核实老人状态' },
      { key: '派单社工', icon: 'route', desc: '就近社工上门处置' },
      { key: '呼叫 120', icon: 'alert', desc: '紧急医疗转运' }
    ];

    var body =
      '<div class="alert-detail-head">' +
        '<div class="alert-detail-icon ' + (a.level === 'critical' ? 'critical' : '') + '">' + YL.icon(type.icon) + '</div>' +
        '<div class="alert-detail-title">' +
          '<b>' + type.text + '</b>' +
          '<span>' + (a.level === 'critical' ? '紧急告警' : '一般告警') + ' · ' + U.fmtDate(a.time, 'YYYY-MM-DD HH:mm:ss') + '</span>' +
        '</div>' +
        '<div class="alert-detail-metric"><b class="num">' + U.esc(a.metric) + '</b><span>触发值 · 持续 ' + U.esc(a.duration) + '</span></div>' +
      '</div>' +

      '<div class="alert-person-card">' +
        '<span class="avatar avatar-lg x-warm">' + U.esc(a.elderName.slice(0, 1)) + '</span>' +
        '<div class="alert-person-main">' +
          '<div class="alert-person-name"><b>' + U.esc(a.elderName) + '</b><span>' + a.elderAge + ' 岁</span>' +
            '<span class="tag tag-red">重点关注</span></div>' +
          '<p>' + YL.icon('map-pin') + U.esc(a.address) + '</p>' +
          '<p>' + YL.icon('users') + '紧急联系人：' + U.esc(a.familyName) + '（' + U.esc(a.relation) + '） · <span class="num">' + U.maskPhone(a.phone) + '</span></p>' +
        '</div>' +
        '<div class="alert-person-actions">' +
          '<button type="button" class="btn btn-sm btn-soft" data-dial>' + YL.icon('phone') + '一键拨号</button>' +
        '</div>' +
      '</div>' +

      '<div class="mini-map">' +
        '<svg viewBox="0 0 340 108" preserveAspectRatio="none" aria-hidden="true">' +
          '<rect width="340" height="108" fill="#F3F7FD"/>' +
          '<path d="M0 76h340v32H0z" fill="#E7EFF9"/>' +
          '<path d="M18 96h300" stroke="#C9D9EE" stroke-width="1.5" stroke-dasharray="6 5"/>' +
          '<path d="M66 92V58l24-18 24 18v34" fill="#DCE9FB" stroke="#B9D1F0"/>' +
          '<path d="M196 92V48l30-22 30 22v44" fill="#E4EEFB" stroke="#B9D1F0"/>' +
          '<circle cx="150" cy="66" r="6" fill="#F53F3F" fill-opacity=".22"/>' +
          '<circle cx="150" cy="66" r="3.2" fill="#F53F3F" stroke="#fff" stroke-width="1.4"/>' +
        '</svg>' +
        '<div class="mini-map-label"><b>老人当前位置</b><span class="mono">' + U.esc(a.location) + '</span></div>' +
      '</div>' +

      (isView ?
        '<div class="handle-result-view">' +
          '<div class="handle-result-head"><b>处置结果</b>' +
            '<span class="tag ' + (a.status === 'false' ? 'tag-gray' : 'tag-green') + '">' + D.DICT.alertStatus[a.status].text + '</span></div>' +
          '<dl class="kv-list">' +
            '<div><span class="k">处理方式</span><span class="v">' + U.esc(a.handleWay || '—') + '</span></div>' +
            '<div><span class="k">处置人</span><span class="v">' + U.esc(a.handler || '—') + '</span></div>' +
            '<div><span class="k">处置时间</span><span class="v">' + (a.handledAt ? U.fmtDate(a.handledAt, 'YYYY-MM-DD HH:mm') : U.fmtDate(a.time, 'YYYY-MM-DD HH:mm')) + '</span></div>' +
            '<div><span class="k">处置说明</span><span class="v">' + U.esc(a.result || '—') + '</span></div>' +
          '</dl>' +
        '</div>'
        :
        '<form id="handleForm" class="handle-form">' +
          '<div class="field"><label>处置方式 <span class="req">*</span></label>' +
            '<div class="way-options">' +
              wayOptions.map(function (w) {
                return '<label class="way-option">' +
                  '<input type="radio" name="way" value="' + w.key + '">' +
                  '<span class="way-card"><span class="way-ico">' + YL.icon(w.icon) + '</span>' +
                    '<b>' + w.key + '</b><em>' + w.desc + '</em></span>' +
                '</label>';
              }).join('') +
            '</div>' +
          '</div>' +
          '<div class="field"><label for="handleResult">处理结果 <span class="req">*</span></label>' +
            '<textarea class="ta" id="handleResult" name="result" placeholder="记录核实情况、处置措施与后续随访安排（不少于 5 个字）"></textarea>' +
            '<p class="field-hint">处置记录将同步至老人档案与服务台账，形成完整闭环。</p></div>' +
          '<div class="info-note warn">' + YL.icon('alert-circle') +
            '<span>紧急告警需在 15 分钟内响应；若联系不上家属，请立即派单村居社工上门核实。</span></div>' +
        '</form>');

    UI.modal({
      size: 'lg',
      title: isView ? '告警处置记录' : '告警处置',
      desc: isView ? '查看本次告警的完整处置链路。' : '请核实老人状态后选择处置方式并填写结果。',
      body: body,
      footer: isView ?
        '<button type="button" class="btn btn-outline" data-close>关闭</button>' +
        '<button type="button" class="btn btn-primary" data-close>知道了</button>'
        :
        '<button type="button" class="btn btn-text" data-false>' + YL.icon('x') + '标记为误报</button>' +
        '<span class="ml-auto"></span>' +
        '<button type="button" class="btn btn-outline" data-close>稍后处理</button>' +
        '<button type="button" class="btn btn-danger" data-submit>' + YL.icon('check') + '提交处置结果</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelector('[data-dial]').addEventListener('click', function () {
          UI.phoneModal(a.phone, a.familyName, a.relation);
        });

        if (isView) return;

        // 处置方式卡片选中态
        overlay.querySelectorAll('input[name="way"]').forEach(function (radio) {
          radio.addEventListener('change', function () {
            overlay.querySelectorAll('.way-option').forEach(function (o) { o.classList.remove('is-checked'); });
            radio.closest('.way-option').classList.add('is-checked');
          });
        });

        overlay.querySelector('[data-false]').addEventListener('click', function () {
          UI.confirm({
            title: '标记为误报？',
            message: '该告警将被归类为设备误报，仍保留在台账中；如频繁误报请调整跌倒检测灵敏度。',
            okText: '确认误报', danger: true
          }).then(function (ok) {
            if (!ok) return;
            S.handleAlert(a.id, {
              status: 'false',
              handler: S.roleConf().name,
              handleWay: '远程核实',
              result: '经电话核实老人状态正常，判定为设备误报，已记录并反馈设备厂商优化算法。'
            });
            UI.toast('已标记为误报，处置记录已归档', 'success');
            api.close();
            renderListInPlace();
          });
        });

        overlay.querySelector('[data-submit]').addEventListener('click', function () {
          var form = overlay.querySelector('#handleForm');
          var way = form.querySelector('input[name="way"]:checked');
          var result = form.querySelector('#handleResult').value.trim();
          if (!way) { UI.toast('请选择处置方式', 'warn'); return; }
          if (result.length < 5) {
            UI.fieldError(form, 'result', '请填写不少于 5 个字的处理结果');
            return;
          }
          S.handleAlert(a.id, {
            status: 'done',
            handler: S.roleConf().name,
            handleWay: way.value,
            result: result
          });
          UI.toast('告警已处置，闭环记录已生成', 'success');
          api.close();
          renderListInPlace();
        });
      }
    });
  }

  function renderListInPlace() {
    var container = document.getElementById('view');
    if (container && YL.router.current() && YL.router.current().path === '/alerts') {
      render(container, YL.router.current());
    }
  }

  function onLiveAlert() {
    var container = document.getElementById('view');
    if (container && YL.router.current() && YL.router.current().path === '/alerts') {
      render(container, YL.router.current());
      UI.toast('收到一条新的设备告警，请及时处置', 'warn', 3200);
    }
  }

  YL.pages = YL.pages || {};
  YL.pages.alerts = { render: render, onLiveAlert: onLiveAlert };
})(window);