/* ==========================================================================
   页面 3：老人档案管理 + 单人档案详情
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;
  var C = YL.charts;

  var state = {
    page: 1,
    size: 8,
    sort: null,
    filters: { q: '', village: '', health: '', member: '' },
    selected: {}
  };

  // 记录最近一次已上报浏览审计的档案，详情重渲染时避免重复上报
  var lastAuditElderId = '';

  /** 操作审计：后端不可用或 api 未就绪时静默跳过，不阻塞页面 */
  function auditLog(action, payload) {
    if (!YL.api || typeof YL.api.audit !== 'function') return;
    try {
      YL.api.audit(action, payload);
    } catch (e) {
      /* 审计失败不影响页面主流程 */
    }
  }

  /* ------------------------------------------------------------------
     列表页
     ------------------------------------------------------------------ */
  function applyQuery(query) {
    state.filters = { q: '', village: '', health: '', member: '' };
    state.page = 1;
    state.sort = null;
    state.selected = {};
    if (!query) return;
    if (query.q) state.filters.q = query.q;
    if (query.village) state.filters.village = query.village;
    if (query.health) state.filters.health = query.health;
    if (query.member) state.filters.member = query.member;
  }

  /** 家属角色绑定的老人（无绑定返回 null）；store 已按家庭范围过滤，取首条即为绑定老人 */
  function boundElder() {
    var list = S.elders();
    return list.length ? list[0] : null;
  }

  function scopedElders() {
    var list = S.elders();
    // 家属仅可见绑定老人，兜底裁剪为 1 条
    if (S.role() === 'family') {
      var bound = list.length ? list[0] : null;
      return bound ? [bound] : [];
    }
    return list;
  }

  function filtered() {
    var f = state.filters;
    var list = scopedElders().filter(function (e) {
      if (f.q) {
        var q = f.q.toLowerCase();
        if (e.name.toLowerCase().indexOf(q) === -1 &&
            e.idCard.indexOf(f.q) === -1 &&
            e.phone.indexOf(f.q) === -1) return false;
      }
      if (f.village && e.village !== f.village) return false;
      if (f.health && e.health !== f.health) return false;
      if (f.member && e.member !== f.member) return false;
      return true;
    });

    if (state.sort) {
      var key = state.sort.key;
      var dir = state.sort.dir === 'asc' ? 1 : -1;
      list = list.slice().sort(function (a, b) {
        var va = a[key], vb = b[key];
        if (key === 'name') return va.localeCompare(vb, 'zh-Hans-CN') * dir;
        if (key === 'lastReport') {
          va = a.lastVitals.at; vb = b.lastVitals.at;
        }
        return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
      });
    }
    return list;
  }

  function statsOf(list) {
    return {
      total: list.length,
      healthy: list.filter(function (e) { return e.health === 'healthy'; }).length,
      semi: list.filter(function (e) { return e.health === 'semi'; }).length,
      disabled: list.filter(function (e) { return e.health === 'disabled'; }).length,
      free: list.filter(function (e) { return e.member === 'free'; }).length
    };
  }

  function metricRow(list) {
    var s = D.SUMMARY;
    var isAdmin = S.role() === 'admin';
    var st = statsOf(list);
    var cells = isAdmin ? [
      ['在册服务老人', U.fmt(s.elderTotal), '人', '覆盖 42 个村居', 'is-brand'],
      ['健康老人', U.fmt(s.health.healthy), '人', '占比 58.5%', 'is-green'],
      ['半自理老人', U.fmt(s.health.semi), '人', '占比 30.4%', 'is-orange'],
      ['失能老人', U.fmt(s.health.disabled), '人', '占比 11.0%', 'is-red'],
      ['兜底保障对象', U.fmt(s.guarantee), '人', '财政全额保障', '']
    ] : [
      ['管辖服务老人', U.fmt(st.total), '人', '流水镇 6 个村居', 'is-brand'],
      ['健康老人', st.healthy, '人', '占比 ' + (st.total ? (st.healthy / st.total * 100).toFixed(0) : 0) + '%', 'is-green'],
      ['半自理老人', st.semi, '人', '需定期随访', 'is-orange'],
      ['失能老人', st.disabled, '人', '重点关注', 'is-red'],
      ['兜底保障对象', st.free, '人', '财政全额保障', '']
    ];

    return '<div class="metrics metrics-' + cells.length + '">' +
      cells.map(function (c) {
        return '<div class="metric ' + c[4] + '">' +
          '<div class="metric-label">' + c[0] + '</div>' +
          '<div class="metric-value">' + c[1] + '<span class="unit">' + c[2] + '</span></div>' +
          '<div class="metric-foot">' + c[3] + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function renderList(container, route) {
    // 回到列表即视为离开详情路由，重置浏览审计去重标志，再次进入同一档案需重新上报
    lastAuditElderId = '';
    var list = scopedElders();
    var villages = D.VILLAGES.filter(function (v) {
      return S.role() === 'admin' || v.town === '流水镇';
    });

    container.innerHTML =
      '<div class="page page-elders">' +
        '<div class="page-head">' +
          '<div>' +
            '<h2>老人档案管理</h2>' +
            '<p>乡村留守、失能半失能与兜底保障老人的统一档案，联动手环设备与健康数据。</p>' +
          '</div>' +
          '<div class="page-actions">' +
            '<button type="button" class="btn btn-outline" id="exportElders">' + YL.icon('download') + '导出档案</button>' +
            /* 完整档案为明文个人信息，仅管理员可见 */
            (U.canSeeRaw() ? '<button type="button" class="btn btn-outline" id="exportArchive">' + YL.icon('download') + '导出完整档案</button>' : '') +
            '<button type="button" class="btn btn-primary" id="addElder">' + YL.icon('plus') + '新增老人档案</button>' +
          '</div>' +
        '</div>' +

        metricRow(list) +

        '<div class="filter-bar">' +
          '<div class="field"><label for="fName">姓名 / 身份证 / 电话</label>' +
            '<div class="input-wrap"><span class="input-ico" data-icon="search"></span>' +
            '<input id="fName" name="q" placeholder="输入关键字检索" value="' + U.esc(state.filters.q) + '"></div></div>' +
          '<div class="field"><label for="fVillage">所属村居</label>' +
            '<div class="input-wrap select-wrap"><select id="fVillage" name="village">' +
              '<option value="">全部村居</option>' +
              villages.map(function (v) {
                return '<option value="' + U.esc(v.name) + '"' + (state.filters.village === v.name ? ' selected' : '') + '>' + v.town + ' · ' + v.name + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label for="fHealth">健康等级</label>' +
            '<div class="input-wrap select-wrap"><select id="fHealth" name="health">' +
              '<option value="">全部等级</option>' +
              '<option value="healthy"' + (state.filters.health === 'healthy' ? ' selected' : '') + '>健康</option>' +
              '<option value="semi"' + (state.filters.health === 'semi' ? ' selected' : '') + '>半自理</option>' +
              '<option value="disabled"' + (state.filters.health === 'disabled' ? ' selected' : '') + '>失能</option>' +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label for="fMember">会员类型</label>' +
            '<div class="input-wrap select-wrap"><select id="fMember" name="member">' +
              '<option value="">全部套餐</option>' +
              '<option value="ankang"' + (state.filters.member === 'ankang' ? ' selected' : '') + '>安康版</option>' +
              '<option value="kanghu"' + (state.filters.member === 'kanghu' ? ' selected' : '') + '>康护版</option>' +
              '<option value="zunxiang"' + (state.filters.member === 'zunxiang' ? ' selected' : '') + '>尊享版</option>' +
              '<option value="free"' + (state.filters.member === 'free' ? ' selected' : '') + '>兜底免费</option>' +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="filter-actions">' +
            '<button type="button" class="btn btn-outline" id="resetFilter">重置</button>' +
            '<button type="button" class="btn btn-primary" id="applyFilter">' + YL.icon('search') + '查询</button>' +
          '</div>' +
        '</div>' +

        '<div class="card table-card">' +
          '<div class="table-toolbar">' +
            '<div class="batch-bar" id="batchBar">' +
              '<span>共 <b>' + U.fmt(list.length) + '</b> 位在册老人</span>' +
              '<span class="text-divider">|</span>' +
              '<span class="t3">点击姓名可查看完整健康档案</span>' +
            '</div>' +
            '<div class="flex gap-2">' +
              '<button type="button" class="btn btn-sm btn-outline" id="batchExport" disabled>批量导出</button>' +
              '<button type="button" class="btn btn-sm btn-outline" id="batchCare" disabled>发起关怀</button>' +
            '</div>' +
          '</div>' +
          '<div class="table-wrap" id="elderTable"></div>' +
          '<div id="elderPager"></div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderTable(container, route);
    bindListEvents(container, route);
  }

  function renderTable(container, route) {
    var all = filtered();
    var pages = Math.max(1, Math.ceil(all.length / state.size));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * state.size;
    var rows = all.slice(start, start + state.size);

    var table = container.querySelector('#elderTable');
    if (!all.length) {
      table.innerHTML = UI.empty('users', '没有匹配的老人档案',
        '尝试调整筛选条件，或新增一位老人档案。',
        '<button type="button" class="btn btn-sm btn-primary" data-empty-add>新增档案</button>');
      container.querySelector('#elderPager').innerHTML = '';
      bindEmptyAdd(container);
      updateBatchBar(container);
      return;
    }

    table.innerHTML =
      '<table class="tbl">' +
        '<thead><tr>' +
          '<th class="col-check"><label class="checkbox"><input type="checkbox" data-check-all>' +
            '<span class="checkbox-box">' + YL.icon('check') + '</span></label></th>' +
          '<th>老人信息</th>' +
          '<th>所属村居</th>' +
          '<th>健康等级</th>' +
          '<th>会员类型</th>' +
          '<th>绑定设备</th>' +
          '<th>' + UI.sortTh('lastReport', '最近体征', state.sort) + '</th>' +
          '<th class="col-actions">操作</th>' +
        '</tr></thead>' +
        '<tbody>' +
          rows.map(function (e) {
            var checked = state.selected[e.id];
            var v = e.lastVitals;
            var abnormal = v.hr > 100 || v.spo2 < 93 || v.sbp > 150;
            return '<tr class="' + (checked ? 'is-selected' : '') + '">' +
              '<td class="col-check"><label class="checkbox"><input type="checkbox" data-check="' + e.id + '"' + (checked ? ' checked' : '') + '>' +
                '<span class="checkbox-box">' + YL.icon('check') + '</span></label></td>' +
              '<td>' +
                '<div class="person">' + UI.avatar(e) +
                  '<div class="person-info">' +
                    '<a class="person-name link-name" href="#/elders/' + e.id + '">' + U.esc(U.maskName(e.name)) + '</a>' +
                    '<div class="person-meta">' + e.gender + ' · ' + e.age + ' 岁 · ' + U.maskIdCard(e.idCard) + '</div>' +
                  '</div>' +
                '</div>' +
              '</td>' +
              '<td><div class="cell-strong">' + U.esc(e.village) + '</div><div class="t-xs t3">' + U.esc(e.town) + '</div></td>' +
              '<td>' + UI.healthTag(e.health) + '</td>' +
              '<td>' + UI.memberTag(e.member) + '</td>' +
              '<td>' + (e.deviceBound === false ? '<span class="t3 t-sm">未绑定</span>' :
                '<span class="mono t-sm">' + U.esc(e.deviceId) + '</span>') + '</td>' +
              '<td>' +
                '<div class="vital-mini' + (abnormal ? ' is-abnormal' : '') + '">' +
                  '<span><i>HR</i>' + v.hr + '</span>' +
                  '<span><i>SpO₂</i>' + v.spo2 + '%</span>' +
                  '<span><i>BP</i>' + v.sbp + '/' + v.dbp + '</span>' +
                '</div>' +
                '<div class="t-xs t3">' + U.relTime(v.at) + ' 上报</div>' +
              '</td>' +
              '<td class="col-actions">' +
                '<button type="button" class="btn-link" data-view="' + e.id + '">查看详情</button>' +
                '<button type="button" class="btn-link" data-edit="' + e.id + '">编辑</button>' +
                '<button type="button" class="btn-link" data-unbind="' + e.id + '"' + (e.deviceBound === false ? ' disabled' : '') + '>解绑</button>' +
              '</td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>';

    container.querySelector('#elderPager').innerHTML = UI.pager({
      total: all.length, page: state.page, size: state.size
    });

    YL.hydrateIcons(table);
    bindTableEvents(container, route);
    updateBatchBar(container);
  }

  function bindTableEvents(container, route) {
    var table = container.querySelector('#elderTable');

    table.querySelectorAll('[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        YL.router.go('/elders/' + btn.getAttribute('data-view'));
      });
    });

    table.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openElderForm(btn.getAttribute('data-edit'), function () { renderTable(container, route); });
      });
    });

    table.querySelectorAll('[data-unbind]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-unbind');
        var elder = findElder(id);
        if (!elder || !elder.deviceId) return;
        UI.confirm({
          title: '解除设备绑定？',
          message: '将解绑「' + U.maskName(elder.name) + '」与设备 ' + elder.deviceId + ' 的关联，解绑后该设备停止上报该老人的健康数据。',
          okText: '确认解绑', danger: true
        }).then(function (ok) {
          if (!ok) return;
          S.unbindDevice(elder.deviceId);
          UI.toast('已解绑设备 ' + elder.deviceId, 'success');
          renderTable(container, route);
        });
      });
    });

    var checkAll = table.querySelector('[data-check-all]');
    if (checkAll) {
      checkAll.addEventListener('change', function () {
        var rows = filtered().slice((state.page - 1) * state.size, state.page * state.size);
        rows.forEach(function (e) { state.selected[e.id] = checkAll.checked; });
        renderTable(container, route);
      });
    }

    table.querySelectorAll('[data-check]').forEach(function (box) {
      box.addEventListener('change', function () {
        state.selected[box.getAttribute('data-check')] = box.checked;
        box.closest('tr').classList.toggle('is-selected', box.checked);
        updateBatchBar(container);
      });
    });

    UI.bindPager(container.querySelector('#elderPager'), function (page, size) {
      if (size) state.size = size;
      state.page = page;
      renderTable(container, route);
    });

    // 排序
    container.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');
        if (!state.sort || state.sort.key !== key) {
          state.sort = { key: key, dir: 'desc' };
        } else {
          state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
        }
        renderTable(container, route);
      });
    });
  }

  function updateBatchBar(container) {
    var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
    var bar = container.querySelector('#batchBar');
    if (bar) {
      if (ids.length) {
        bar.innerHTML = '<span>已选择 <b>' + ids.length + '</b> 位老人</span>' +
          '<span class="text-divider">|</span>' +
          '<button type="button" class="btn-link" id="clearSelection">取消选择</button>';
        var clear = bar.querySelector('#clearSelection');
        if (clear) {
          clear.addEventListener('click', function () {
            state.selected = {};
            renderTable(container, YL.router.current());
          });
        }
      } else {
        bar.innerHTML = '<span>共 <b>' + U.fmt(scopedElders().length) + '</b> 位在册老人</span>' +
          '<span class="text-divider">|</span><span class="t3">点击姓名可查看完整健康档案</span>';
      }
    }
    var batchExport = container.querySelector('#batchExport');
    var batchCare = container.querySelector('#batchCare');
    if (batchExport) batchExport.disabled = !ids.length;
    if (batchCare) batchCare.disabled = !ids.length;
  }

  function bindEmptyAdd(container) {
    var btn = container.querySelector('[data-empty-add]');
    if (btn) btn.addEventListener('click', function () { openElderForm(null, function () { renderList(container, YL.router.current()); }); });
  }

  function bindListEvents(container, route) {
    var q = container.querySelector('#fName');
    var village = container.querySelector('#fVillage');
    var health = container.querySelector('#fHealth');
    var member = container.querySelector('#fMember');

    function apply() {
      state.filters = {
        q: q.value.trim(),
        village: village.value,
        health: health.value,
        member: member.value
      };
      state.page = 1;
      state.selected = {};
      renderTable(container, route);
    }

    container.querySelector('#applyFilter').addEventListener('click', apply);
    container.querySelector('#resetFilter').addEventListener('click', function () {
      q.value = ''; village.value = ''; health.value = ''; member.value = '';
      apply();
    });
    [village, health, member].forEach(function (sel) {
      sel.addEventListener('change', apply);
    });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });

    container.querySelector('#addElder').addEventListener('click', function () {
      openElderForm(null, function () { renderList(container, YL.router.current()); });
    });

    container.querySelector('#exportElders').addEventListener('click', function () {
      exportElders(filtered());
    });

    // 明文导出需二次确认，仅在管理员入口下存在
    var archiveBtn = container.querySelector('#exportArchive');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', function () {
        confirmArchiveExport(function () {
          exportElders(filtered(), true);
        });
      });
    }

    container.querySelector('#batchExport').addEventListener('click', function () {
      var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
      exportElders(scopedElders().filter(function (e) { return ids.indexOf(e.id) !== -1; }));
      UI.toast('已导出 ' + ids.length + ' 位老人的档案', 'success');
    });

    container.querySelector('#batchCare').addEventListener('click', function () {
      var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
      UI.confirm({
        title: '发起关怀工单',
        message: '将为选中的 ' + ids.length + ' 位老人创建上门关怀工单，并指派至所属村居社工。',
        okText: '创建工单'
      }).then(function (ok) {
        if (!ok) return;
        ids.forEach(function (id) {
          var e = findElder(id);
          if (!e) return;
          S.addOrder({
            elderId: e.id, elderName: e.name, village: e.village, town: e.town,
            phone: e.phone, type: 'care', owner: e.volunteer,
            volunteer: '', appointAt: Date.now() + 86400000,
            remark: '批量发起的关怀工单，请提前电话联系。'
          });
        });
        state.selected = {};
        UI.toast('已创建 ' + ids.length + ' 张关怀工单', 'success');
        renderTable(container, route);
      });
    });
  }

  /** 明文档案导出二次确认：仅「确认导出」后执行 onOk */
  function confirmArchiveExport(onOk) {
    UI.modal({
      size: 'sm',
      title: '导出完整档案',
      body: '<p class="t-sm" style="line-height:1.7">本次将导出含真实姓名与联系电话的完整档案，请确认使用场景符合数据安全管理要求。</p>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-confirm-export>确认导出（明文）</button>',
      onMount: function (api, overlay) {
        overlay.querySelector('[data-confirm-export]').addEventListener('click', function () {
          api.close();
          onOk();
        });
      }
    });
  }

  /** 导出老人档案 CSV：raw 为 true 时输出明文，默认脱敏 */
  function exportElders(list, raw) {
    var plain = raw === true;
    var headers = ['档案编号', '姓名', '性别', '年龄', '身份证号', '所属村居', '乡镇', '健康等级', '会员类型', '绑定设备', '最近心率', '最近血氧', '家属姓名', '家属电话'];
    var rows = list.map(function (e) {
      return [e.id, plain ? e.name : U.maskName(e.name), e.gender, e.age, U.maskIdCard(e.idCard), e.village, e.town,
        D.DICT.health[e.health].text, D.DICT.member[e.member].text,
        e.deviceBound === false ? '未绑定' : e.deviceId,
        e.lastVitals.hr, e.lastVitals.spo2,
        plain ? e.familyName : U.maskName(e.familyName),
        plain ? e.phone : U.maskPhone(e.phone)];
    });
    U.download('银龄岚途_老人档案_' + U.fmtDate(new Date(), 'YYYYMMDD') + '.csv',
      U.toCSV(headers, rows));

    // 导出审计只记录条数与首个档案编号，不含档案内容；detail 序列化后受 512 字符上限约束
    var ids = list.map(function (e) { return e.id; });
    auditLog('elder_export', {
      target_type: 'elder',
      target_id: ids.length === 1 ? ids[0] : 'batch',
      result: 'ok',
      detail: { count: rows.length, first_id: ids[0] || '' }
    });
  }

  function findElder(id) {
    return S.state.elders.filter(function (e) { return e.id === id; })[0];
  }

  /* ------------------------------------------------------------------
     新增 / 编辑档案
     ------------------------------------------------------------------ */
  function openElderForm(id, onDone) {
    var elder = id ? findElder(id) : null;
    var isEdit = !!elder;
    // 非管理员编辑时，表单仅回填脱敏值；新增档案保持空值
    var canRaw = U.canSeeRaw();
    var formName = elder ? (canRaw ? elder.name : U.maskName(elder.name)) : '';
    var formAddress = elder ? (canRaw ? elder.address : U.maskAddress(elder.address)) : '';
    var formFamily = elder ? (canRaw ? elder.familyName : U.maskName(elder.familyName)) : '';
    var formPhone = elder ? (canRaw ? elder.phone : U.maskPhone(elder.phone)) : '';
    // 仅编辑态且无明文权限时提示「脱敏值需重新输入」
    var maskTip = (isEdit && !canRaw) ? '<span class="t-xs t3">（当前为脱敏值，修改请重新输入完整内容）</span>' : '';
    var villages = D.VILLAGES.filter(function (v) {
      return S.role() === 'admin' || v.town === '流水镇';
    });

    UI.drawer({
      title: isEdit ? '编辑老人档案' : '新增老人档案',
      desc: isEdit ? '档案变更将同步至村居社工与绑定设备。' : '建档后可为老人绑定「银龄守护」手环并纳入健康监测。',
      body:
        '<form id="elderForm" class="form-grid" autocomplete="off">' +
          '<div class="field"><label>姓名 <span class="req">*</span>' + maskTip + '</label>' +
            '<div class="input-wrap"><input name="name" placeholder="请输入老人姓名" value="' + U.esc(formName) + '"></div></div>' +
          '<div class="field"><label>性别 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="gender">' +
              '<option value="女"' + (elder && elder.gender === '女' ? ' selected' : '') + '>女</option>' +
              '<option value="男"' + (elder && elder.gender === '男' ? ' selected' : '') + '>男</option>' +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>年龄 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input name="age" type="number" min="50" max="110" placeholder="60 - 110" value="' + (elder ? elder.age : '') + '"></div></div>' +
          '<div class="field"><label>所属村居 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="village">' +
              villages.map(function (v) {
                return '<option value="' + U.esc(v.name) + '"' + (elder && elder.village === v.name ? ' selected' : '') + '>' + v.town + ' · ' + v.name + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>健康等级 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="health">' +
              '<option value="healthy"' + (elder && elder.health === 'healthy' ? ' selected' : '') + '>健康</option>' +
              '<option value="semi"' + (elder && elder.health === 'semi' ? ' selected' : '') + '>半自理</option>' +
              '<option value="disabled"' + (elder && elder.health === 'disabled' ? ' selected' : '') + '>失能</option>' +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>会员类型 <span class="req">*</span></label>' +
            '<div class="input-wrap select-wrap"><select name="member">' +
              '<option value="ankang"' + (elder && elder.member === 'ankang' ? ' selected' : '') + '>安康版</option>' +
              '<option value="kanghu"' + (elder && elder.member === 'kanghu' ? ' selected' : '') + '>康护版</option>' +
              '<option value="zunxiang"' + (elder && elder.member === 'zunxiang' ? ' selected' : '') + '>尊享版</option>' +
              '<option value="free"' + (elder && elder.member === 'free' ? ' selected' : '') + '>兜底免费</option>' +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field span-2"><label>居住地址 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input name="address" placeholder="村居门牌号" value="' + U.esc(formAddress) + '"></div></div>' +
          '<div class="field"><label>家属姓名 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input name="familyName" placeholder="紧急联系人" value="' + U.esc(formFamily) + '"></div></div>' +
          '<div class="field"><label>家属电话 <span class="req">*</span>' + maskTip + '</label>' +
            '<div class="input-wrap"><input name="phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号" value="' + U.esc(formPhone) + '"></div></div>' +
          '<div class="field"><label>与老人关系</label>' +
            '<div class="input-wrap select-wrap"><select name="relation">' +
              ['女儿', '儿子', '儿媳', '孙子', '侄女', '其他'].map(function (r) {
                return '<option value="' + r + '"' + (elder && elder.relation === r ? ' selected' : '') + '>' + r + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>慢病病史</label>' +
            '<div class="input-wrap"><input name="chronic" placeholder="如：高血压、糖尿病（逗号分隔）" value="' + U.esc(elder ? elder.chronic.join('、') : '') + '"></div></div>' +
          '<div class="field span-2"><label>备注</label>' +
            '<textarea class="ta" name="remark" placeholder="记录老人的生活习惯、注意事项等">' + U.esc(elder ? (elder.remark || '') : '') + '</textarea></div>' +
        '</form>',
      footer:
        '<span class="foot-left">带 <span style="color:var(--red)">*</span> 为必填项</span>' +
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-save>' + (isEdit ? '保存修改' : '创建档案') + '</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelector('[data-save]').addEventListener('click', function () {
          var form = overlay.querySelector('#elderForm');
          var data = UI.formData(form);
          // 非管理员未修改的脱敏字段，提交时还原为原始真实值，避免把 * 写回数据
          var phoneUntouched = false;
          if (isEdit && !canRaw && elder) {
            if (data.name === U.maskName(elder.name)) data.name = elder.name;
            if (data.familyName === U.maskName(elder.familyName)) data.familyName = elder.familyName;
            if (data.address === U.maskAddress(elder.address)) data.address = elder.address;
            if (data.phone === U.maskPhone(elder.phone)) {
              data.phone = elder.phone;
              phoneUntouched = true;
            }
          }
          UI.clearErrors(form);
          var ok = true;
          if (!data.name) { UI.fieldError(form, 'name', '请输入老人姓名'); ok = false; }
          if (!data.age || Number(data.age) < 50 || Number(data.age) > 110) {
            UI.fieldError(form, 'age', '年龄需在 50 - 110 之间'); ok = false;
          }
          if (!phoneUntouched && !/^1[3-9]\d{9}$/.test(data.phone)) {
            UI.fieldError(form, 'phone', '请输入正确的 11 位手机号'); ok = false;
          }
          if (!ok) return;

          var village = D.VILLAGE_MAP[data.village] || D.VILLAGES[0];
          var payload = {
            name: data.name,
            gender: data.gender,
            age: Number(data.age),
            health: data.health,
            member: data.member,
            village: data.village,
            town: village.town,
            villageId: village.id,
            address: data.address || ('平潭综合实验区' + village.town + village.name),
            familyName: data.familyName || '—',
            phone: data.phone,
            relation: data.relation,
            chronic: data.chronic ? data.chronic.split(/[、,，]/).filter(Boolean) : [],
            risk: data.health === 'disabled' ? 'high' : (data.health === 'semi' ? 'mid' : 'low'),
            remark: data.remark || ''
          };

          if (isEdit) {
            S.updateElder(elder.id, payload);
            UI.toast('档案已更新', 'success');
          } else {
            S.addElder(payload);
            UI.toast('老人档案创建成功', 'success');
          }
          api.close();
          if (onDone) onDone();
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     档案详情
     ------------------------------------------------------------------ */
  function renderDetail(container, route) {
    // 家属仅可查看绑定老人的档案
    if (S.role() === 'family') {
      var bound = boundElder();
      if (!bound || bound.id !== route.params.id) {
        container.innerHTML = '<div class="page">' + UI.empty('shield', '无权查看该老人档案',
          '当前账号仅可查看已绑定家属的老人档案。',
          '<a class="btn btn-primary" href="#/elders">返回档案列表</a>') + '</div>';
        return;
      }
    }

    var elder = findElder(route.params.id);
    if (!elder) {
      container.innerHTML = '<div class="page">' + UI.empty('users', '未找到该老人档案', '档案可能已被归档，请返回列表重新选择。',
        '<a class="btn btn-primary" href="#/elders">返回档案列表</a>') + '</div>';
      return;
    }

    // 同一档案的后续重渲染（如保存后刷新）不重复上报
    if (lastAuditElderId !== elder.id) {
      lastAuditElderId = elder.id;
      auditLog('elder_view', { target_type: 'elder', target_id: elder.id, result: 'ok' });
    }

    // 仅管理员可查看明文姓名 / 电话 / 地址，其余角色统一脱敏展示
    var canRaw = U.canSeeRaw();
    var showName = canRaw ? elder.name : U.maskName(elder.name);
    var showPhone = canRaw ? elder.phone : U.maskPhone(elder.phone);
    var showFamily = canRaw ? elder.familyName : U.maskName(elder.familyName);
    var showAddress = canRaw ? elder.address : U.maskAddress(elder.address);

    var member = D.DICT.member[elder.member];
    var v = elder.lastVitals;
    var series = D.vitalSeries(elder, 30);
    var records = D.serviceRecords(elder);
    var alerts = S.alerts().filter(function (a) { return a.elderId === elder.id; }).slice(0, 4);
    var expire = U.fmtDate(U.daysFromNow(elder.member === 'free' ? 365 : 120 + (Number(elder.id.replace(/\D/g, '')) % 200)), 'YYYY-MM-DD');
    var remain = elder.member === 'free' ? 99 : (elder.member === 'zunxiang' ? 12 : elder.member === 'kanghu' ? 6 : 3);
    var used = elder.member === 'free' ? 12 : (elder.member === 'zunxiang' ? 36 : elder.member === 'kanghu' ? 18 : 6);

    container.innerHTML =
      '<div class="page page-elder-detail">' +
        '<div class="detail-nav">' +
          '<a class="back-link" href="#/elders">' + YL.icon('arrow-left') + '返回档案列表</a>' +
          '<div class="detail-nav-actions">' +
            '<button type="button" class="btn btn-outline" data-call-elder>' + YL.icon('phone') + '联系家属</button>' +
            '<button type="button" class="btn btn-outline" data-ai>' + YL.icon('spark') + 'AI 健康分析</button>' +
            '<button type="button" class="btn btn-primary" data-edit-elder>' + YL.icon('edit') + '编辑档案</button>' +
          '</div>' +
        '</div>' +

        '<section class="profile-head card">' +
          '<div class="profile-main">' +
            '<span class="avatar avatar-lg ' + elder.avatarClass + '">' + U.esc(showName.slice(0, 1)) + '</span>' +
            '<div class="profile-info">' +
              '<div class="profile-name">' +
                '<h2>' + U.esc(showName) + '</h2>' +
                UI.healthTag(elder.health) +
                UI.memberTag(elder.member) +
                (elder.risk === 'high' ? '<span class="tag tag-red">重点关注</span>' : '') +
              '</div>' +
              '<p class="profile-meta">' + elder.gender + ' · ' + elder.age + ' 岁 · ' + U.esc(elder.village) + '（' + U.esc(elder.town) + '） · 档案编号 ' + elder.id + '</p>' +
              '<p class="profile-addr">' + YL.icon('map-pin') + U.esc(showAddress) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="profile-vitals">' +
            '<div><span>心率</span><b class="num">' + v.hr + '</b><em>bpm</em></div>' +
            '<div><span>血压</span><b class="num">' + v.sbp + '/' + v.dbp + '</b><em>mmHg</em></div>' +
            '<div><span>血氧</span><b class="num">' + v.spo2 + '</b><em>%</em></div>' +
            '<div><span>体温</span><b class="num">' + v.temp + '</b><em>℃</em></div>' +
            '<div class="profile-vital-time"><span class="status online"><span class="dot"></span>设备在线</span><em>' + U.relTime(v.at) + ' 上报</em></div>' +
          '</div>' +
        '</section>' +

        '<div class="detail-grid">' +
          '<div class="detail-col-side">' +
            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('user') + '基础信息</div></div>' +
              '<div class="card-body">' +
                '<dl class="kv-list">' +
                  '<div><span class="k">身份证号</span><span class="v mono">' + U.maskIdCard(elder.idCard) + '</span></div>' +
                  '<div><span class="k">出生日期</span><span class="v">' + elder.birth + '</span></div>' +
                  '<div><span class="k">紧急联系人</span><span class="v">' + U.esc(showFamily) + '（' + U.esc(elder.relation) + '）</span></div>' +
                  '<div><span class="k">联系电话</span><span class="v num">' + U.esc(showPhone) + '</span></div>' +
                  '<div><span class="k">慢病病史</span><span class="v">' + (elder.chronic.length ?
                    elder.chronic.map(function (c) { return '<span class="tag tag-outline" style="margin:0 4px 4px 0">' + U.esc(c) + '</span>'; }).join('') :
                    '<span class="t3">暂无登记</span>') + '</span></div>' +
                  '<div><span class="k">责任社工</span><span class="v">' + U.esc(elder.volunteer) + '</span></div>' +
                  '<div><span class="k">建档时间</span><span class="v">' + U.fmtDate(elder.joinedAt, 'YYYY-MM-DD') + '</span></div>' +
                '</dl>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('watch') + '设备与会员</div></div>' +
              '<div class="card-body">' +
                '<div class="device-brief">' +
                  '<div class="device-brief-icon">' + YL.icon('watch') + '</div>' +
                  '<div class="device-brief-main">' +
                    '<b class="mono">' + (elder.deviceBound === false ? '未绑定设备' : elder.deviceId) + '</b>' +
                    '<span>银龄守护手环 P1 · 鸿蒙智联</span>' +
                  '</div>' +
                  (elder.deviceBound === false ? '' : '<span class="status online"><span class="dot"></span>在线</span>') +
                '</div>' +
                '<div class="divider"></div>' +
                '<div class="member-block">' +
                  '<div class="member-head"><span>' + member.text + '</span><b class="num">' + (member.price || '政府购买') + (member.price ? ' 元 / 年' : '') + '</b></div>' +
                  '<div class="member-progress"><div class="bar"><i style="width:' + (used / (used + remain) * 100) + '%"></i></div>' +
                    '<span>已使用 <b class="num">' + used + '</b> 次 · 剩余 <b class="num">' + remain + '</b> 次</span></div>' +
                  '<p class="member-expire">套餐有效期至 <b>' + expire + '</b>，到期前 7 天自动提醒续费。</p>' +
                '</div>' +
              '</div>' +
            '</article>' +
          '</div>' +

          '<div class="detail-col-main">' +
            '<article class="card">' +
              '<div class="card-head">' +
                '<div class="card-title">' + YL.icon('activity') + '健康档案 · 近 30 天体征曲线</div>' +
                '<div class="card-extra"><span class="pill pill-brand">华为云 IoT 上报</span></div>' +
              '</div>' +
              '<div class="card-body">' +
                '<div class="vital-chart-block">' +
                  '<div class="vital-chart-label"><span>心率 / 血压</span><em>心率 bpm · 血压 mmHg</em></div>' +
                  '<div class="chart" id="chElderVital" style="height:196px"></div>' +
                '</div>' +
                '<div class="vital-chart-block">' +
                  '<div class="vital-chart-label"><span>血氧饱和度</span><em>正常区间 95% - 100%</em></div>' +
                  '<div class="chart" id="chElderSpo2" style="height:132px"></div>' +
                '</div>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head">' +
                '<div class="card-title">' + YL.icon('clipboard') + '服务与处置记录</div>' +
                '<div class="card-extra"><button type="button" class="btn-link" data-new-order>发起服务工单</button></div>' +
              '</div>' +
              '<div class="card-body two-col">' +
                '<div>' +
                  '<h4 class="sub-title">服务记录</h4>' +
                  '<div class="timeline">' +
                    records.map(function (r, i) {
                      return '<div class="tl-item ' + (i === 0 ? 'done' : '') + '">' +
                        '<div class="tl-head"><span class="tl-title">' + U.esc(r.type) + '</span><span class="tl-time">' + U.fmtDate(r.time, 'MM-DD HH:mm') + '</span></div>' +
                        '<div class="tl-desc">' + U.esc(r.note) + ' · 服务人 ' + U.esc(r.worker) + '</div>' +
                      '</div>';
                    }).join('') +
                  '</div>' +
                '</div>' +
                '<div>' +
                  '<h4 class="sub-title">告警记录</h4>' +
                  (alerts.length ? '<div class="timeline">' + alerts.map(function (a) {
                    return '<div class="tl-item ' + (a.level === 'critical' ? 'critical' : '') + '">' +
                      '<div class="tl-head"><span class="tl-title">' + D.DICT.alertType[a.type].text + '</span><span class="tl-time">' + U.fmtDate(a.time, 'MM-DD HH:mm') + '</span></div>' +
                      '<div class="tl-desc">' + D.DICT.alertStatus[a.status].text + ' · ' + U.esc(a.result || '等待村居社工处置') + '</div>' +
                    '</div>';
                  }).join('') + '</div>' : UI.empty('shield', '暂无告警记录', '该老人近 30 天未触发设备告警。')) +
                '</div>' +
              '</div>' +
            '</article>' +
          '</div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);

    C.mount(container.querySelector('#chElderVital'), C.vitalTrendOption(series.labels, [
      { name: '心率 (bpm)', data: series.hr, color: '#165DFF', area: true },
      { name: '收缩压 (mmHg)', data: series.sbp, color: '#FF7D00' },
      { name: '舒张压 (mmHg)', data: series.dbp, color: '#94BFFF', dashed: true }
    ]));
    C.mount(container.querySelector('#chElderSpo2'), C.areaOption(series.labels, series.spo2, { color: '#00B42A', min: 88 }));

    container.querySelector('[data-call-elder]').addEventListener('click', function () {
      // 电话弹窗展示明文号码，仅管理员可调用
      if (!canRaw) {
        UI.toast('无权限查看完整号码', 'warn');
        return;
      }
      UI.phoneModal(elder.phone, elder.familyName, elder.relation);
    });
    container.querySelector('[data-edit-elder]').addEventListener('click', function () {
      openElderForm(elder.id, function () { renderDetail(container, route); });
    });
    container.querySelector('[data-ai]').addEventListener('click', function () {
      YL.router.go('/ai?elder=' + elder.id);
    });
    container.querySelector('[data-new-order]').addEventListener('click', function () {
      if (YL.pages.orders && YL.pages.orders.openCreate) {
        YL.pages.orders.openCreate(elder.id, function () {
          UI.toast('工单创建成功，可在服务工单中查看', 'success');
        });
      } else {
        YL.router.go('/orders');
      }
    });
  }

  function render(container, route) {
    if (route.params.id) {
      renderDetail(container, route);
    } else {
      applyQuery(route.query);
      renderList(container, route);
    }
  }

  YL.pages = YL.pages || {};
  YL.pages.elders = {
    render: render,
    /** 导出全量老人完整档案（明文）；二次确认由调用方负责 */
    exportArchive: function () {
      // 除 UI 层二次确认外，函数内再做一次权限校验，防止脚本直接调用导出明文
      if (!U.canSeeRaw()) { UI.toast('无权限导出完整档案', 'error'); return; }
      exportElders(S.state.elders, true);
    }
  };
})(window);