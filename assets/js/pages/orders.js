/* ==========================================================================
   页面 6：服务工单管理（创建 / 派单 / 结案 / 评价）
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;

  var state = { tab: 'all', page: 1, size: 8, type: '' };

  var WORKERS = ['蔡文静', '念晓东', '施小燕', '高建平', '魏丽云', '林美珍'];
  var VOLUNTEERS = ['陈思远', '林小满', '翁雨晴', '念佳怡', '蔡子豪', '周晓彤', '游书航', '施安安'];

  function counts() {
    var list = S.orders();
    return {
      all: list.length,
      pending: list.filter(function (o) { return o.status === 'pending'; }).length,
      doing: list.filter(function (o) { return o.status === 'doing'; }).length,
      done: list.filter(function (o) { return o.status === 'done'; }).length,
      canceled: list.filter(function (o) { return o.status === 'canceled'; }).length
    };
  }

  function filtered() {
    return S.orders().filter(function (o) {
      if (state.tab !== 'all' && o.status !== state.tab) return false;
      if (state.type && o.type !== state.type) return false;
      return true;
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /* ------------------------------------------------------------------
     列表
     ------------------------------------------------------------------ */
  function render(container, route) {
    var c = counts();
    var s = D.SUMMARY;

    container.innerHTML =
      '<div class="page page-orders">' +
        '<div class="page-head">' +
          '<div><h2>服务工单管理</h2>' +
            '<p>上门关怀、陪诊、康复护理与家政服务全流程留痕，服务完成后由家属评价。</p></div>' +
          '<div class="page-actions">' +
            '<button type="button" class="btn btn-outline" id="exportOrders">' + YL.icon('download') + '导出工单</button>' +
            '<button type="button" class="btn btn-primary" id="createOrder">' + YL.icon('plus') + '新建工单</button>' +
          '</div>' +
        '</div>' +

        '<div class="metrics metrics-4">' +
          '<div class="metric is-orange"><div class="metric-label">' + YL.icon('clock') + '待处理</div>' +
            '<div class="metric-value">' + c.pending + '<span class="unit">单</span></div>' +
            '<div class="metric-foot">需在 2 小时内派单</div></div>' +
          '<div class="metric is-brand"><div class="metric-label">进行中</div>' +
            '<div class="metric-value">' + c.doing + '<span class="unit">单</span></div>' +
            '<div class="metric-foot">服务执行中</div></div>' +
          '<div class="metric is-green"><div class="metric-label">已完成</div>' +
            '<div class="metric-value">' + c.done + '<span class="unit">单</span></div>' +
            '<div class="metric-foot">完成率 ' + s.completionRate + '%</div></div>' +
          '<div class="metric"><div class="metric-label">已取消</div>' +
            '<div class="metric-value">' + c.canceled + '<span class="unit">单</span></div>' +
            '<div class="metric-foot">含老人临时外出</div></div>' +
        '</div>' +

        '<div class="order-layout">' +
          '<div class="card table-card">' +
            '<div class="alert-tabs">' +
              '<div class="tabs" id="orderTabs">' +
                [['all', '全部', c.all], ['pending', '待处理', c.pending], ['doing', '进行中', c.doing], ['done', '已完成', c.done], ['canceled', '已取消', c.canceled]]
                  .map(function (t) {
                    return '<button type="button" class="tab' + (state.tab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '">' +
                      t[1] + '<span class="count">' + t[2] + '</span></button>';
                  }).join('') +
              '</div>' +
              '<div class="alert-tools">' +
                '<div class="input-wrap select-wrap" style="width:150px">' +
                  '<select id="orderTypeFilter">' +
                    '<option value="">全部类型</option>' +
                    Object.keys(D.DICT.orderType).map(function (k) {
                      return '<option value="' + k + '"' + (state.type === k ? ' selected' : '') + '>' + D.DICT.orderType[k].text + '</option>';
                    }).join('') +
                  '</select><span class="select-caret" data-icon="chevron"></span>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="table-wrap" id="orderTable"></div>' +
            '<div id="orderPager"></div>' +
          '</div>' +

          '<aside class="order-side">' +
            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('clipboard') + '本月工单类型</div></div>' +
              '<div class="card-body">' +
                Object.keys(D.DICT.orderType).map(function (k) {
                  var v = s.orderTypes[k];
                  var total = s.orderTypes.care;
                  return '<div class="type-row">' +
                    '<div class="type-row-head"><span>' + D.DICT.orderType[k].text + '</span><b class="num">' + v + '</b></div>' +
                    '<div class="bar"><i style="width:' + (v / total * 100) + '%"></i></div>' +
                  '</div>';
                }).join('') +
                '<div class="divider"></div>' +
                '<div class="mini-kv"><span>平均服务时长</span><b class="num">68 分钟</b></div>' +
                '<div class="mini-kv"><span>家属好评率</span><b class="num">98.2%</b></div>' +
                '<div class="mini-kv"><span>超时未结案</span><b class="num" style="color:var(--orange)">2 单</b></div>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('users') + '服务力量</div></div>' +
              '<div class="card-body">' +
                '<div class="force-grid">' +
                  '<div><b class="num">24</b><span>在岗社工</span></div>' +
                  '<div><b class="num">486</b><span>注册志愿者</span></div>' +
                  '<div><b class="num">12</b><span>合作机构</span></div>' +
                  '<div><b class="num">39</b><span>老人协会</span></div>' +
                '</div>' +
                '<div class="info-note mt-3">' + YL.icon('info') +
                  '<span>工单按村居就近派单，志愿者服务时长自动计入志愿帮扶台账，可用于民政积分兑换。</span></div>' +
              '</div>' +
            '</article>' +
          '</aside>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderTable(container);
    bind(container);
  }

  function renderTable(container) {
    var all = filtered();
    var pages = Math.max(1, Math.ceil(all.length / state.size));
    if (state.page > pages) state.page = pages;
    var rows = all.slice((state.page - 1) * state.size, state.page * state.size);
    var table = container.querySelector('#orderTable');

    if (!all.length) {
      table.innerHTML = UI.empty('clipboard', '暂无该类工单', '可点击右上角「新建工单」为老人安排服务。',
        '<button type="button" class="btn btn-sm btn-primary" data-create-empty>新建工单</button>');
      container.querySelector('#orderPager').innerHTML = '';
      var emptyBtn = table.querySelector('[data-create-empty]');
      if (emptyBtn) emptyBtn.addEventListener('click', function () { openCreate(null, function () { render(container, YL.router.current()); }); });
      return;
    }

    table.innerHTML =
      '<table class="tbl">' +
        '<thead><tr>' +
          '<th>工单编号</th><th>服务老人</th><th>工单类型</th><th>预约时间</th>' +
          '<th>负责人</th><th>状态</th><th>创建时间</th><th class="col-actions">操作</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (o) {
          return '<tr>' +
            '<td><span class="mono t-sm cell-strong">' + U.esc(o.id) + '</span></td>' +
            '<td><div class="person"><span class="avatar avatar-sm x-slate">' + U.esc(U.maskName(o.elderName).slice(0, 1)) + '</span>' +
              '<div class="person-info"><span class="person-name">' + U.esc(U.maskName(o.elderName)) + '</span>' +
                '<span class="person-meta">' + U.esc(o.village) + '</span></div></div></td>' +
            '<td><span class="order-type-cell">' + YL.icon(D.DICT.orderType[o.type].icon) + D.DICT.orderType[o.type].text + '</span></td>' +
            '<td><span class="t-sm">' + U.fmtDate(o.appointAt, 'MM-DD HH:mm') + '</span>' +
              '<div class="t-xs t3">' + (o.appointAt < Date.now() && o.status !== 'done' ? '<span style="color:var(--orange)">已到预约时间</span>' : U.relTime(o.appointAt)) + '</div></td>' +
            '<td><span class="t-sm">' + U.esc(o.owner) + '</span>' +
              (o.volunteer ? '<div class="t-xs t3">志愿者 ' + U.esc(o.volunteer) + '</div>' : '') + '</td>' +
            '<td>' + UI.statusTag(D.DICT.orderStatus, o.status) + '</td>' +
            '<td><span class="t-xs t3">' + U.fmtDate(o.createdAt, 'MM-DD HH:mm') + '</span></td>' +
            '<td class="col-actions">' +
              '<button type="button" class="btn-link" data-order-view="' + o.id + '">查看</button>' +
              (o.status === 'pending' ? '<button type="button" class="btn-link" data-order-assign="' + o.id + '">派单</button>' : '') +
              (o.status === 'doing' ? '<button type="button" class="btn-link" data-order-close="' + o.id + '">结案</button>' : '') +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';

    container.querySelector('#orderPager').innerHTML = UI.pager({ total: all.length, page: state.page, size: state.size });
    YL.hydrateIcons(table);

    table.querySelectorAll('[data-order-view]').forEach(function (b) {
      b.addEventListener('click', function () { YL.router.go('/orders/' + b.getAttribute('data-order-view')); });
    });
    table.querySelectorAll('[data-order-assign]').forEach(function (b) {
      b.addEventListener('click', function () { openAssign(b.getAttribute('data-order-assign'), function () { render(container, YL.router.current()); }); });
    });
    table.querySelectorAll('[data-order-close]').forEach(function (b) {
      b.addEventListener('click', function () { openClose(b.getAttribute('data-order-close'), function () { render(container, YL.router.current()); }); });
    });

    UI.bindPager(container.querySelector('#orderPager'), function (page, size) {
      if (size) state.size = size;
      state.page = page;
      renderTable(container);
    });
  }

  function bind(container) {
    container.querySelectorAll('#orderTabs [data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        container.querySelectorAll('#orderTabs .tab').forEach(function (t) { t.classList.remove('active'); });
        b.classList.add('active');
        state.tab = b.getAttribute('data-tab');
        state.page = 1;
        renderTable(container);
      });
    });

    container.querySelector('#orderTypeFilter').addEventListener('change', function () {
      state.type = this.value;
      state.page = 1;
      renderTable(container);
    });

    container.querySelector('#createOrder').addEventListener('click', function () {
      openCreate(null, function () { render(container, YL.router.current()); });
    });

    container.querySelector('#exportOrders').addEventListener('click', function () {
      var list = filtered();
      var raw = U.canSeeRaw();
      var headers = ['工单编号', '服务老人', '所属村居', '工单类型', '预约时间', '负责人', '志愿者', '状态', '创建时间', '服务小结', '家属评分'];
      var rows = list.map(function (o) {
        return [o.id, raw ? o.elderName : U.maskName(o.elderName), o.village, D.DICT.orderType[o.type].text,
          U.fmtDate(o.appointAt, 'YYYY-MM-DD HH:mm'), o.owner, o.volunteer || '—',
          D.DICT.orderStatus[o.status].text, U.fmtDate(o.createdAt, 'YYYY-MM-DD HH:mm'),
          o.summary || '—', o.rating ? o.rating + ' 星' : '—'];
      });
      U.download('银龄岚途_服务工单_' + U.fmtDate(new Date(), 'YYYYMMDD') + '.csv', U.toCSV(headers, rows));
      UI.toast('已导出 ' + list.length + ' 条工单记录', 'success');
    });
  }

  function findOrder(id) {
    return S.orders().filter(function (o) { return o.id === id; })[0];
  }

  /* ------------------------------------------------------------------
     新建工单
     ------------------------------------------------------------------ */
  function openCreate(elderId, onDone) {
    var elders = S.elders();
    var defaultTime = U.fmtDate(U.daysFromNow(1), 'YYYY-MM-DD') + 'T09:00';

    UI.modal({
      size: 'lg',
      title: '新建服务工单',
      desc: '选择服务对象、服务类型并指派负责人，工单将同步至村居社工工作台。',
      body:
        '<form id="orderForm" class="form-grid">' +
          '<div class="field span-2"><label>服务老人 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="elderId">' +
              '<option value="">请选择服务对象</option>' +
              elders.map(function (e) {
                return '<option value="' + e.id + '"' + (elderId === e.id ? ' selected' : '') + '>' +
                  U.esc(U.maskName(e.name)) + ' · ' + e.age + ' 岁 · ' + U.esc(e.village) + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>服务类型 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="type">' +
              Object.keys(D.DICT.orderType).map(function (k) {
                return '<option value="' + k + '">' + D.DICT.orderType[k].text + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>预约时间 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input type="datetime-local" name="appointAt" value="' + defaultTime + '"></div></div>' +
          '<div class="field"><label>指派社工 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="owner">' +
              WORKERS.map(function (w) { return '<option>' + w + '</option>'; }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>协同志愿者</label>' +
            '<div class="input-wrap select-wrap"><select name="volunteer">' +
              '<option value="">暂不指派</option>' +
              VOLUNTEERS.map(function (w) { return '<option>' + w + '</option>'; }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field span-2"><label>服务要求 / 备注</label>' +
            '<textarea class="ta" name="remark" placeholder="如：老人独居，需携带血压计；家属希望服务后反馈照片"></textarea></div>' +
          '<div class="info-note span-2">' + YL.icon('info') +
            '<span>工单创建后进入「待处理」，派单后社工上门服务，服务完成填写小结并由家属评价。</span></div>' +
        '</form>',
      footer:
        '<span class="foot-left">工单编号将自动生成</span>' +
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-save-order>创建工单</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelector('[data-save-order]').addEventListener('click', function () {
          var form = overlay.querySelector('#orderForm');
          var data = UI.formData(form);
          UI.clearErrors(form);
          if (!data.elderId) { UI.toast('请选择服务老人', 'warn'); return; }
          if (!data.appointAt) { UI.fieldError(form, 'appointAt', '请选择预约时间'); return; }

          var elder = S.state.elders.filter(function (e) { return e.id === data.elderId; })[0];
          if (!elder) { UI.toast('老人档案不存在', 'warn'); return; }

          var order = S.addOrder({
            elderId: elder.id,
            elderName: elder.name,
            village: elder.village,
            town: elder.town,
            phone: elder.phone,
            type: data.type,
            owner: data.owner,
            volunteer: data.volunteer || '',
            appointAt: new Date(data.appointAt).getTime(),
            remark: data.remark || ''
          });
          UI.toast('工单 ' + order.id + ' 创建成功', 'success');
          api.close();
          if (onDone) onDone(order);
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     派单
     ------------------------------------------------------------------ */
  function openAssign(id, onDone) {
    var o = findOrder(id);
    if (!o) return;
    UI.modal({
      size: 'sm',
      title: '工单派单',
      desc: o.id + ' · ' + D.DICT.orderType[o.type].text + ' · ' + U.esc(U.maskName(o.elderName)),
      body:
        '<form id="assignForm" class="form-stack">' +
          '<div class="field"><label>指派社工 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="owner">' +
              WORKERS.map(function (w) {
                return '<option' + (w === o.owner ? ' selected' : '') + '>' + w + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>协同志愿者</label>' +
            '<div class="input-wrap select-wrap"><select name="volunteer">' +
              '<option value="">暂不指派</option>' +
              VOLUNTEERS.map(function (w) {
                return '<option' + (w === o.volunteer ? ' selected' : '') + '>' + w + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="info-note">' + YL.icon('route') +
            '<span>按村居就近原则推荐：' + U.esc(o.village) + ' 责任社工 ' + U.esc(o.owner) + '。</span></div>' +
        '</form>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-do-assign>确认派单</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelector('[data-do-assign]').addEventListener('click', function () {
          var data = UI.formData(overlay.querySelector('#assignForm'));
          S.updateOrder(o.id, { owner: data.owner, volunteer: data.volunteer || '', status: 'doing' });
          UI.toast('已派单给 ' + data.owner + '，工单进入进行中', 'success');
          api.close();
          if (onDone) onDone();
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     结案
     ------------------------------------------------------------------ */
  function openClose(id, onDone) {
    var o = findOrder(id);
    if (!o) return;
    UI.modal({
      title: '工单结案',
      desc: o.id + ' · ' + U.esc(U.maskName(o.elderName)) + ' · ' + D.DICT.orderType[o.type].text,
      body:
        '<form id="closeForm" class="form-stack">' +
          '<div class="form-grid">' +
            '<div class="field"><label>实际服务时长（分钟）</label>' +
              '<div class="input-wrap"><input name="duration" type="number" min="10" max="300" value="60"></div></div>' +
            '<div class="field"><label>家属满意度</label>' +
              '<div class="input-wrap select-wrap"><select name="rating">' +
                '<option value="5">5 星 · 非常满意</option><option value="4">4 星 · 满意</option>' +
                '<option value="3">3 星 · 一般</option>' +
              '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '</div>' +
          '<div class="field"><label>服务小结 <span class="req">*</span></label>' +
            '<textarea class="ta" name="summary" placeholder="记录本次服务内容、老人身体与情绪状态、后续建议"></textarea></div>' +
          '<div class="field"><label>现场照片</label>' +
            '<div class="upload-zone" data-upload>' + YL.icon('camera') +
              '<b>点击上传服务现场照片</b><span>支持 JPG / PNG，单张不超过 5MB（演示环境使用占位图）</span></div>' +
            '<div class="photo-row" id="photoRow"></div>' +
          '</div>' +
        '</form>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-do-close>确认结案</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        var count = 0;
        var row = overlay.querySelector('#photoRow');
        overlay.querySelector('[data-upload]').addEventListener('click', function () {
          count++;
          row.insertAdjacentHTML('beforeend', UI.photoThumb(count + 3, '现场照片 ' + count));
          if (count >= 3) overlay.querySelector('[data-upload]').style.display = 'none';
          UI.toast('已添加现场照片（演示占位图）', 'success', 1600);
        });
        overlay.querySelector('[data-do-close]').addEventListener('click', function () {
          var form = overlay.querySelector('#closeForm');
          var data = UI.formData(form);
          if (!data.summary || data.summary.length < 5) {
            UI.fieldError(form, 'summary', '请填写不少于 5 个字的服务小结');
            return;
          }
          S.updateOrder(o.id, {
            status: 'done',
            summary: data.summary,
            duration: Number(data.duration) || 60,
            rating: Number(data.rating) || 5,
            photos: count
          });
          UI.toast('工单已结案，服务记录已归档', 'success');
          api.close();
          if (onDone) onDone();
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     工单详情
     ------------------------------------------------------------------ */
  function renderDetail(container, route) {
    var o = findOrder(route.params.id);
    if (!o) {
      container.innerHTML = '<div class="page">' + UI.empty('clipboard', '未找到该工单', '工单可能已被归档，请返回列表查看。',
        '<a class="btn btn-primary" href="#/orders">返回工单列表</a>') + '</div>';
      return;
    }

    var created = o.createdAt;
    var assigned = o.status !== 'pending' ? created + 3600000 : null;
    var served = o.status === 'done' ? o.appointAt : null;
    var finished = o.status === 'done' ? o.appointAt + (o.duration || 60) * 60000 : null;

    var steps = [
      { title: '工单创建', time: created, done: true, desc: '由 ' + S.roleConf().name + ' 创建，服务类型：' + D.DICT.orderType[o.type].text },
      { title: '派单确认', time: assigned, done: !!assigned, desc: assigned ? '指派社工 ' + o.owner + (o.volunteer ? '，协同志愿者 ' + o.volunteer : '') : '等待派单' },
      { title: '上门服务', time: served, done: !!served, desc: served ? '按预约时间上门，服务时长 ' + (o.duration || 60) + ' 分钟' : '等待服务执行' },
      { title: '服务结案', time: finished, done: o.status === 'done', desc: o.status === 'done' ? '已填写服务小结，等待家属评价' : '等待结案' }
    ];

    container.innerHTML =
      '<div class="page page-order-detail">' +
        '<div class="detail-nav">' +
          '<a class="back-link" href="#/orders">' + YL.icon('arrow-left') + '返回工单列表</a>' +
          '<div class="detail-nav-actions">' +
            (o.status === 'pending' ? '<button type="button" class="btn btn-outline" data-assign>派单</button>' : '') +
            (o.status === 'doing' ? '<button type="button" class="btn btn-primary" data-close-order>结案</button>' : '') +
            '<button type="button" class="btn btn-outline" data-print>' + YL.icon('download') + '打印工单</button>' +
          '</div>' +
        '</div>' +

        '<section class="order-hero card">' +
          '<div class="order-hero-main">' +
            '<div class="order-hero-top"><span class="mono order-hero-id">' + U.esc(o.id) + '</span>' +
              UI.statusTag(D.DICT.orderStatus, o.status) +
              '<span class="tag tag-outline">' + D.DICT.orderType[o.type].text + '</span></div>' +
            '<h2>' + U.esc(U.maskName(o.elderName)) + ' · ' + D.DICT.orderType[o.type].text + '</h2>' +
            '<p>' + U.esc(o.village) + ' · 预约 ' + U.fmtDate(o.appointAt, 'YYYY-MM-DD HH:mm') + ' · 负责人 ' + U.esc(o.owner) + '</p>' +
          '</div>' +
          '<div class="order-hero-stats">' +
            '<div><span>创建时间</span><b class="num">' + U.fmtDate(o.createdAt, 'MM-DD HH:mm') + '</b></div>' +
            '<div><span>服务时长</span><b class="num">' + (o.duration || '—') + (o.duration ? ' 分钟' : '') + '</b></div>' +
            '<div><span>家属评价</span><b>' + (o.rating ? stars(o.rating) : '<span class="t3 t-sm">待评价</span>') + '</b></div>' +
          '</div>' +
        '</section>' +

        '<div class="detail-grid">' +
          '<div class="detail-col-side">' +
            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('clipboard') + '工单信息</div></div>' +
              '<div class="card-body">' +
                '<dl class="kv-list">' +
                  '<div><span class="k">工单编号</span><span class="v mono">' + U.esc(o.id) + '</span></div>' +
                  '<div><span class="k">服务对象</span><span class="v"><a class="link-name" href="#/elders/' + o.elderId + '">' + U.esc(U.maskName(o.elderName)) + '</a>（' + U.esc(o.village) + '）</span></div>' +
                  '<div><span class="k">联系电话</span><span class="v num">' + U.maskPhone(o.phone) + '</span></div>' +
                  '<div><span class="k">服务类型</span><span class="v">' + D.DICT.orderType[o.type].text + '</span></div>' +
                  '<div><span class="k">预约时间</span><span class="v">' + U.fmtDate(o.appointAt, 'YYYY-MM-DD HH:mm') + '</span></div>' +
                  '<div><span class="k">负责社工</span><span class="v">' + U.esc(o.owner) + '</span></div>' +
                  '<div><span class="k">协同志愿者</span><span class="v">' + U.esc(o.volunteer || '—') + '</span></div>' +
                  '<div><span class="k">服务要求</span><span class="v">' + U.esc(o.remark || '—') + '</span></div>' +
                '</dl>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('camera') + '服务现场</div>' +
                '<span class="card-sub">' + (o.photos || (o.status === 'done' ? 2 : 0)) + ' 张</span></div>' +
              '<div class="card-body">' +
                (o.status === 'done' ?
                  '<div class="photo-grid">' +
                    UI.photoThumb(1, '上门服务') +
                    UI.photoThumb(2, '体征测量') +
                    UI.photoThumb(3, '服务记录') +
                  '</div>' :
                  '<div class="photo-empty">' + YL.icon('camera') + '<b>服务完成后上传现场照片</b><span>用于服务留痕与家属反馈</span></div>') +
              '</div>' +
            '</article>' +
          '</div>' +

          '<div class="detail-col-main">' +
            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('route') + '服务流程</div></div>' +
              '<div class="card-body">' +
                '<div class="timeline order-timeline">' +
                  steps.map(function (st) {
                    return '<div class="tl-item ' + (st.done ? 'done' : '') + '">' +
                      '<div class="tl-head"><span class="tl-title">' + st.title + '</span>' +
                        '<span class="tl-time">' + (st.time ? U.fmtDate(st.time, 'MM-DD HH:mm') : '—') + '</span></div>' +
                      '<div class="tl-desc">' + U.esc(st.desc) + '</div>' +
                    '</div>';
                  }).join('') +
                '</div>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('file-text') + '服务小结与评价</div></div>' +
              '<div class="card-body">' +
                (o.status === 'done' ?
                  '<div class="summary-block">' +
                    '<div class="summary-head"><b>服务小结</b><span class="t3 t-sm">由 ' + U.esc(o.owner) + ' 填写</span></div>' +
                    '<p>' + U.esc(o.summary || '服务已完成，老人状态平稳。') + '</p>' +
                    '<div class="divider"></div>' +
                    '<div class="rating-block">' +
                      '<div><b>家属评价</b><p class="t3 t-sm">' + U.fmtDate(o.appointAt + 86400000, 'YYYY-MM-DD') + ' 由家属 ' + U.esc(U.maskName(o.elderName)) + ' 的家属提交</p></div>' +
                      '<div class="rating-stars">' + stars(o.rating || 5) + '<span>' + (o.rating || 5) + '.0</span></div>' +
                    '</div>' +
                    '<p class="rating-text">“社工准时上门，态度很好，还帮忙测量了血压，非常感谢。” </p>' +
                  '</div>' :
                  '<div class="empty" style="padding:32px 0">' +
                    '<div class="empty-art">' + YL.icon('file-text') + '</div>' +
                    '<b>服务尚未结案</b><p>服务完成后由负责人填写服务小结，家属可在小程序端评价。</p>' +
                    (o.status === 'doing' ? '<button type="button" class="btn btn-sm btn-primary" data-close-order>立即结案</button>' : '') +
                  '</div>') +
              '</div>' +
            '</article>' +
          '</div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);

    var assignBtn = container.querySelector('[data-assign]');
    if (assignBtn) assignBtn.addEventListener('click', function () {
      openAssign(o.id, function () { renderDetail(container, route); });
    });
    container.querySelectorAll('[data-close-order]').forEach(function (b) {
      b.addEventListener('click', function () {
        openClose(o.id, function () { renderDetail(container, route); });
      });
    });
    container.querySelector('[data-print]').addEventListener('click', function () {
      UI.toast('已生成工单 PDF（演示环境请在浏览器中打印预览）', 'info');
      setTimeout(function () { window.print(); }, 600);
    });
  }

  function stars(n) {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<span class="star' + (i <= n ? ' on' : '') + '">' + YL.icon('star') + '</span>';
    }
    return '<span class="stars">' + html + '</span>';
  }

  function renderPage(container, route) {
    if (route.params.id) renderDetail(container, route);
    else render(container, route);
  }

  YL.pages = YL.pages || {};
  YL.pages.orders = { render: renderPage, openCreate: openCreate };
})(window);