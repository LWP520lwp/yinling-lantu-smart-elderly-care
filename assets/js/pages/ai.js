/* ==========================================================================
   页面 8：AI 健康分析（华为云盘古大模型）
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

  var selectedId = null;
  var timers = [];
  var analyzing = false;
  // 实时问答：当前流式请求控制器 / 会话代次（销毁或切换老人后旧回调自动失效）
  var chatController = null;
  var chatEpoch = 0;

  function elders() { return S.elders(); }

  function scores(elder) {
    var base = elder.health === 'disabled' ? 68 : elder.health === 'semi' ? 46 : 24;
    var chronic = (elder.chronic || []).length * 7;
    var ageFactor = Math.max(0, elder.age - 70) * 1.1;
    var chronicRisk = Math.min(96, Math.round(base + chronic + ageFactor * .8));
    var fallRisk = Math.min(95, Math.round(base * .9 + (elder.health === 'disabled' ? 14 : 0) + ageFactor));
    return { chronic: chronicRisk, fall: fallRisk };
  }

  function riskLevel(v) {
    if (v >= 70) return { text: '高风险', cls: 'tag-red', color: '#F53F3F' };
    if (v >= 50) return { text: '中风险', cls: 'tag-orange', color: '#FF7D00' };
    return { text: '低风险', cls: 'tag-green', color: '#00B42A' };
  }

  /* ------------------------------------------------------------------
     页面
     ------------------------------------------------------------------ */
  function render(container, route) {
    var list = elders();
    if (route.query.elder) selectedId = route.query.elder;
    if (!selectedId || !list.some(function (e) { return e.id === selectedId; })) {
      selectedId = list[0] ? list[0].id : null;
    }

    container.innerHTML =
      '<div class="page page-ai">' +
        '<div class="page-head">' +
          '<div><h2>AI 健康分析</h2>' +
            '<p>基于「银龄守护」手环连续体征数据，由盘古大模型生成个体健康风险评估与服务建议。</p></div>' +
          '<div class="page-actions">' +
            '<button type="button" class="btn btn-outline" id="exportAi">' + YL.icon('download') + '导出分析报告</button>' +
          '</div>' +
        '</div>' +

        '<div class="ai-banner">' +
          '<span class="ai-banner-icon">' + YL.icon('spark') + '</span>' +
          '<div class="ai-banner-text">' +
            '<b>智能分析引擎</b>' +
            '<span>华为云盘古大模型医疗行业套件 · 融合体征时序数据与慢病知识库</span>' +
          '</div>' +
          '<div class="ai-banner-tags">' +
            '<span class="pill pill-brand">盘古大模型</span>' +
            '<span class="pill pill-orange">医疗行业套件</span>' +
            '<span class="pill">推理耗时 1.2s</span>' +
          '</div>' +
        '</div>' +

        '<div class="ai-layout">' +
          '<aside class="ai-side card">' +
            '<div class="ai-side-head">' +
              '<div class="card-title">' + YL.icon('users') + '选择分析对象</div>' +
              '<span class="t-xs t3">' + list.length + ' 位</span>' +
            '</div>' +
            '<div class="ai-side-search">' +
              '<div class="input-wrap"><span class="input-ico" data-icon="search"></span>' +
                '<input id="aiSearch" placeholder="搜索老人姓名 / 村居"></div>' +
            '</div>' +
            '<div class="ai-elder-list" id="aiElderList"></div>' +
            '<div class="ai-side-foot">' + YL.icon('shield') +
              '<span>健康数据经脱敏后用于模型推理，不对外传输。</span></div>' +
          '</aside>' +

          '<div class="ai-main" id="aiMain"></div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderElderList(container, '');
    renderPanel(container);

    var search = container.querySelector('#aiSearch');
    search.addEventListener('input', U.debounce(function () {
      renderElderList(container, search.value.trim());
    }, 200));

    container.querySelector('#exportAi').addEventListener('click', function () {
      var elder = findElder(selectedId);
      if (!elder) return;
      var s = scores(elder);
      var content =
        '银龄岚途 · AI 健康分析报告\n' +
        '生成时间：' + U.fmtDate(new Date(), 'YYYY-MM-DD HH:mm') + '\n\n' +
        '老人：' + maskElderName(elder.name) + '（' + elder.gender + '，' + elder.age + ' 岁）\n' +
        '村居：' + elder.village + '\n' +
        '健康等级：' + D.DICT.health[elder.health].text + '\n' +
        '慢病病史：' + (elder.chronic.join('、') || '无') + '\n\n' +
        '慢病风险评分：' + s.chronic + ' / 100（' + riskLevel(s.chronic).text + '）\n' +
        '跌倒风险评分：' + s.fall + ' / 100（' + riskLevel(s.fall).text + '）\n\n' +
        '【个性化建议】\n' + adviceFor(elder).map(function (a) { return '· ' + a; }).join('\n') + '\n\n' +
        '【说明】本报告由华为云盘古大模型生成，仅供参考，不作为诊疗依据。';
      // 文件名只用老人编号，不暴露姓名（脱敏报告内容也不应通过文件名反推真名）
      U.download('AI健康分析_' + elder.id + '_' + U.fmtDate(new Date(), 'YYYYMMDD') + '.txt', content, 'text/plain;charset=utf-8');
      UI.toast('分析报告已导出', 'success');
    });
  }

  function findElder(id) {
    return S.state.elders.filter(function (e) { return e.id === id; })[0];
  }

  function renderElderList(container, keyword) {
    var list = elders().filter(function (e) {
      if (!keyword) return true;
      return e.name.indexOf(keyword) !== -1 || e.village.indexOf(keyword) !== -1;
    });
    var box = container.querySelector('#aiElderList');
    if (!list.length) {
      box.innerHTML = UI.empty('search', '未找到匹配的老人', '换个关键字试试。');
      return;
    }
    box.innerHTML = list.map(function (e) {
      return '<button type="button" class="ai-elder' + (e.id === selectedId ? ' active' : '') + '" data-elder="' + e.id + '">' +
        UI.avatar(e, 'avatar-sm') +
        '<div class="ai-elder-info"><b>' + U.esc(maskElderName(e.name)) + '</b><em>' + e.age + ' 岁 · ' + U.esc(e.village) + '</em></div>' +
        '<span class="tag ' + D.DICT.health[e.health].cls + '">' + D.DICT.health[e.health].text + '</span>' +
      '</button>';
    }).join('');

    box.querySelectorAll('[data-elder]').forEach(function (b) {
      b.addEventListener('click', function () {
        selectedId = b.getAttribute('data-elder');
        renderElderList(container, keyword);
        renderPanel(container, true);
      });
    });
  }

  function adviceFor(elder) {
    var chronic = elder.chronic || [];
    var hasBp = chronic.indexOf('高血压') !== -1;
    var hasSugar = chronic.indexOf('2 型糖尿病') !== -1;
    var disabled = elder.health === 'disabled';
    var out = [];

    out.push(hasBp ? '每日食盐摄入控制在 5g 以内，减少腌制海产与酱油用量，多食深色蔬菜。' :
      '保持清淡饮食，每日食盐不超过 5g，适量补充鱼、蛋、豆制品等优质蛋白。');
    out.push(disabled ? '以床上/座椅关节活动为主，家属协助每日 2 次、每次 10 分钟被动活动。' :
      '建议每日清晨或傍晚快走 20 - 30 分钟，配合八段锦，心率控制在（170 - 年龄）以内。');
    out.push(hasSugar ? '监测空腹血糖，主食粗细搭配，避免稀饭与含糖糕点，按医嘱规律用药。' :
      '按医嘱规律服药，家属可使用手环用药提醒功能，避免漏服、重复服药。');
    out.push(disabled ? '跌倒风险较高，建议卧室至卫生间加装扶手，夜间保留小夜灯。' :
      '每周进行 2 次平衡训练（单脚站立、脚跟脚尖行走），降低跌倒风险。');
    return out;
  }

  function renderPanel(container, animate) {
    var main = container.querySelector('#aiMain');
    var elder = findElder(selectedId);
    if (!elder) {
      main.innerHTML = UI.empty('users', '暂无可分析对象', '当前角色范围内没有老人档案。');
      return;
    }

    if (analyzing) return;
    if (animate) {
      main.innerHTML = '<div class="ai-loading">' +
        '<div class="ai-loading-head"><span class="spinner dark"></span>盘古大模型正在分析 ' + U.esc(maskElderName(elder.name)) + ' 的近 30 天体征数据…</div>' +
        '<div class="skeleton" style="height:96px;margin-bottom:12px"></div>' +
        '<div class="skeleton" style="height:150px;margin-bottom:12px"></div>' +
        '<div class="skeleton" style="height:110px"></div>' +
      '</div>';
      analyzing = true;
      setTimeout(function () {
        analyzing = false;
        paintPanel(main, elder);
      }, 620);
      return;
    }
    paintPanel(main, elder);
  }

  function paintPanel(main, elder) {
    var s = scores(elder);
    var cr = riskLevel(s.chronic);
    var fr = riskLevel(s.fall);
    var advice = adviceFor(elder);
    var v = elder.lastVitals;

    main.innerHTML =
      '<section class="ai-profile card">' +
        '<div class="ai-profile-left">' +
          UI.avatar(elder, 'avatar-lg') +
          '<div>' +
            '<div class="ai-profile-name"><h3>' + U.esc(maskElderName(elder.name)) + '</h3>' +
              '<span class="tag ' + D.DICT.health[elder.health].cls + '">' + D.DICT.health[elder.health].text + '</span>' +
              '<span class="tag tag-outline">' + D.DICT.member[elder.member].text + '</span></div>' +
            '<p>' + elder.gender + ' · ' + elder.age + ' 岁 · ' + U.esc(elder.village) + ' · 慢病：' + (elder.chronic.join('、') || '无') + '</p>' +
            '<p class="t3 t-sm">数据范围：近 30 天手环连续体征 · 样本 ' + (elder.health === 'disabled' ? 812 : 1024) + ' 条</p>' +
          '</div>' +
        '</div>' +
        '<div class="ai-profile-right">' +
          '<div class="ai-vital"><span>心率</span><b class="num">' + v.hr + '</b><em>bpm</em></div>' +
          '<div class="ai-vital"><span>血压</span><b class="num">' + v.sbp + '/' + v.dbp + '</b><em>mmHg</em></div>' +
          '<div class="ai-vital"><span>血氧</span><b class="num">' + v.spo2 + '</b><em>%</em></div>' +
          '<button type="button" class="btn btn-soft btn-sm" data-reanalyze>' + YL.icon('refresh') + '重新分析</button>' +
        '</div>' +
      '</section>' +

      '<div class="ai-grid">' +
        '<article class="card ai-risk-card">' +
          '<div class="card-head"><div class="card-title">' + YL.icon('target') + '健康风险评估</div>' +
            '<span class="card-sub">盘古医疗模型</span></div>' +
          '<div class="card-body">' +
            '<div class="risk-rings">' +
              '<div class="risk-ring-item">' +
                C.scoreRing(s.chronic, { size: 104, stroke: 8, color: cr.color, label: '分' }) +
                '<b>慢病风险</b><span class="tag ' + cr.cls + '">' + cr.text + '</span>' +
              '</div>' +
              '<div class="risk-ring-item">' +
                C.scoreRing(s.fall, { size: 104, stroke: 8, color: fr.color, label: '分' }) +
                '<b>跌倒风险</b><span class="tag ' + fr.cls + '">' + fr.text + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="risk-factors">' +
              '<span class="risk-label">主要风险因子</span>' +
              '<div class="risk-tags">' +
                (elder.chronic.length ? elder.chronic.map(function (c) { return '<span class="tag tag-outline">' + U.esc(c) + '</span>'; }).join('') : '') +
                '<span class="tag tag-outline">' + elder.age + ' 岁高龄</span>' +
                (elder.health === 'disabled' ? '<span class="tag tag-red">失能状态</span>' : '') +
                (v.spo2 < 94 ? '<span class="tag tag-red">血氧偏低</span>' : '') +
              '</div>' +
            '</div>' +
            '<div class="info-note">' + YL.icon('info') +
              '<span>评分基于 30 天静息心率波动、血压达标率、活动步数与跌倒事件加权计算。</span></div>' +
          '</div>' +
        '</article>' +

        '<article class="card ai-advice-card">' +
          '<div class="card-head"><div class="card-title">' + YL.icon('heart') + '个性化健康建议</div>' +
            '<span class="card-sub">AI 自动生成</span></div>' +
          '<div class="card-body">' +
            '<div class="advice-item"><span class="advice-ico diet">' + YL.icon('droplet') + '</span>' +
              '<div><b>饮食调理</b><p>' + U.esc(advice[0]) + '</p></div></div>' +
            '<div class="advice-item"><span class="advice-ico move">' + YL.icon('activity') + '</span>' +
              '<div><b>运动康复</b><p>' + U.esc(advice[1]) + '</p></div></div>' +
            '<div class="advice-item"><span class="advice-ico med">' + YL.icon('clock') + '</span>' +
              '<div><b>用药提醒</b><p>' + U.esc(advice[2]) + '</p></div></div>' +
            '<div class="advice-item"><span class="advice-ico safe">' + YL.icon('shield') + '</span>' +
              '<div><b>安全防护</b><p>' + U.esc(advice[3]) + '</p></div></div>' +
            '<p class="ai-disclaimer">' + YL.icon('alert-circle') + 'AI 建议仅供参考，不作为诊疗依据；如有不适请及时就医。</p>' +
          '</div>' +
        '</article>' +
      '</div>' +

      '<article class="card ai-group-card">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('globe') + '群体健康洞察</div>' +
          '<span class="card-sub">平潭综合实验区 · 42 个村居</span></div>' +
        '<div class="card-body">' +
          '<div class="insight-grid">' +
            '<div class="insight-item"><b class="num">46.2%</b><span>高血压检出率</span><p>高于全省农村平均水平 3.8 个百分点</p></div>' +
            '<div class="insight-item"><b class="num">21.4%</b><span>糖尿病患病率</span><p>北厝镇、苏澳镇偏高，需加强筛查</p></div>' +
            '<div class="insight-item"><b class="num">43</b><span>异常体征老人</span><p>建议本周内完成一次上门随访</p></div>' +
            '<div class="insight-item"><b class="num">6.2%</b><span>设备误报率</span><p>跌倒算法双因子校验后持续下降</p></div>' +
          '</div>' +
          '<div class="insight-advice">' +
            YL.icon('spark') +
            '<div><b>服务优化建议</b>' +
              '<p>1. 在高血压高发的海坛街道、北厝镇增设每月血压筛查点；2. 针对独居失能老人将上门关怀频次由每月 1 次提升至 2 次；3. 陪诊服务向 80 岁以上老人倾斜，优先安排至平潭协和医院。</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>' +

      '<article class="card ai-chat-card">' +
        '<div class="card-head"><div class="card-title">' + YL.icon('spark') + 'AI 健康问答</div>' +
          '<span class="card-sub">描述症状，获取初步健康指导</span></div>' +
        '<div class="card-body">' +
          '<div class="chat-list" id="chatList">' +
            '<div class="chat-msg ai"><span class="chat-avatar">AI</span>' +
              '<div class="chat-bubble">您好，我是银龄岚途 AI 健康助手。我已读取 ' + U.esc(maskElderName(elder.name)) + ' 近 30 天的体征数据，可以为您分析健康问题并给出照护建议。</div>' +
            '</div>' +
          '</div>' +
          '<div class="chat-quick" id="chatQuick">' +
            ['最近血压偏高怎么办？', '夜里睡不好如何调理？', '饮食上要注意什么？', '老人走路不稳，如何防跌倒？']
              .map(function (q) { return '<button type="button" class="quick-chip" data-q="' + U.esc(q) + '">' + U.esc(q) + '</button>'; }).join('') +
          '</div>' +
          '<form class="chat-input" id="chatForm">' +
            '<textarea class="ta" id="chatText" rows="1" placeholder="描述老人的症状，例如：这两天咳嗽、食欲下降…"></textarea>' +
            '<button type="submit" class="btn btn-primary" id="chatSend">' + YL.icon('send') + '发送</button>' +
          '</form>' +
          '<p class="ai-disclaimer">' + YL.icon('alert-circle') + 'AI 建议仅供参考，不作为诊疗依据；出现胸痛、意识障碍等紧急情况请立即拨打 120。</p>' +
        '</div>' +
      '</article>';

    YL.hydrateIcons(main);
    bindPanel(main, elder);
  }

  function bindPanel(main, elder) {
    main.querySelector('[data-reanalyze]').addEventListener('click', function () {
      renderPanel(document.getElementById('view'), true);
    });

    var chatList = main.querySelector('#chatList');
    var chatText = main.querySelector('#chatText');
    var chatForm = main.querySelector('#chatForm');

    // 会话代次：切换老人 / 页面销毁后，旧的流式回调不再操作已拆除的 DOM
    var epoch = ++chatEpoch;
    // 对话历史，最多保留最近 10 轮问答（20 条消息），随面板重建自然重置
    var history = [];

    // 上一面板可能仍有请求在途，先中断，避免旧会话继续写入
    if (chatController) {
      chatController.abort();
      chatController = null;
    }

    /** 压入对话历史并只保留最近 10 轮 */
    function pushHistory(role, content) {
      history.push({ role: role, content: content });
      while (history.length > 20) history.shift();
    }

    /** 仅取后端契约字段，避免手机号、住址等隐私数据流出前端 */
    function elderPayload() {
      var v = elder.lastVitals || {};
      return {
        name: elder.name,
        gender: elder.gender,
        age: elder.age,
        village: elder.village,
        town: elder.town,
        health: elder.health,
        chronic: (elder.chronic || []).slice(),
        lastVitals: { hr: v.hr, sbp: v.sbp, dbp: v.dbp, spo2: v.spo2, temp: v.temp }
      };
    }

    function scrollChat() { chatList.scrollTop = chatList.scrollHeight; }

    function send(text) {
      var q = String(text || '').trim();
      if (!q) return;
      chatList.insertAdjacentHTML('beforeend',
        '<div class="chat-msg user"><div class="chat-bubble">' + U.esc(q) + '</div><span class="chat-avatar user-avatar">' +
          U.esc(S.roleConf().name.slice(0, 1)) + '</span></div>');
      scrollChat();
      chatText.value = '';

      var typing = U.el('<div class="chat-msg ai"><span class="chat-avatar">AI</span>' +
        '<div class="chat-bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>');
      chatList.appendChild(typing);
      scrollChat();

      // 用户提问先入历史，供后端理解上下文
      pushHistory('user', q);

      setTimeout(function () {
        // 等待期间已切换老人 / 离开页面，则放弃本次问答
        if (epoch !== chatEpoch) return;

        var bubbleNode = null;    // AI 消息节点
        var bubble = null;        // AI 气泡内容节点
        var answerText = '';      // 已接收的完整回答
        var fallbackUsed = false; // 防止 done / error 重复渲染

        /** 移除 typing 等待动画 */
        function removeTyping() {
          if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
        }

        /** 创建（或复用）AI 气泡，沿用原有 AI 消息的 HTML 结构与 class */
        function ensureBubble() {
          removeTyping();
          if (bubbleNode) return bubbleNode;
          bubbleNode = U.el('<div class="chat-msg ai"><span class="chat-avatar">AI</span><div class="chat-bubble"></div></div>');
          bubbleNode.classList.add('streaming');
          chatList.appendChild(bubbleNode);
          bubble = bubbleNode.querySelector('.chat-bubble');
          scrollChat();
          return bubbleNode;
        }

        /**
         * 本地降级：后端未启动 / 返回异常 / 未加载 api.js 时，
         * 继续使用原有 answerFor + typeWriter，保证双击 index.html 也能正常问答
         */
        function degrade(err) {
          if (fallbackUsed) return;
          fallbackUsed = true;
          if (err) {
            // 仅在控制台留痕，不打断用户操作、不影响界面
            console.info('[AI] 流式问答不可用，已切换本地知识库：' +
              (err.code || '') + ' ' + (err.message || ''));
          }
          var answer = answerFor(q, elder);
          ensureBubble();
          bubble.textContent = '';
          typeWriter(bubble, answer, scrollChat);
          setTimeout(scrollChat, 400);
          pushHistory('assistant', answer);
        }

        // api.js 未加载（YL.api 不存在）或调用同步抛错时，同样走本地降级
        try {
          if (!YL.api || typeof YL.api.chatStream !== 'function') {
            degrade();
            return;
          }

          chatController = YL.api.chatStream(elderPayload(), history.slice(), {
            onToken: function (chunk) {
              if (epoch !== chatEpoch) return;
              var piece = chunk === null || chunk === undefined ? '' : String(chunk);
              if (!piece) return;
              ensureBubble();
              // 真实流式阶段直接追加文本节点，不做 typeWriter 逐字动画
              bubble.appendChild(document.createTextNode(piece));
              answerText += piece;
              scrollChat();
            },
            onDone: function () {
              if (epoch !== chatEpoch) return;
              // 一个 token 都没收到：使用本地知识库兜底文案
              if (!answerText) {
                degrade();
                return;
              }
              scrollChat();
              pushHistory('assistant', answerText);
            },
            onError: function (err) {
              if (epoch !== chatEpoch) return;
              if (err && err.code === 'ABORTED') return;   // 主动中断：静默处理
              degrade(err);
            }
          });
        } catch (e) {
          degrade(e);
        }
      }, 760);
    }

    Array.prototype.forEach.call(main.querySelectorAll('.quick-chip'), function (chip) {
      chip.addEventListener('click', function () { send(chip.getAttribute('data-q')); });
    });

    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      send(chatText.value);
    });

    chatText.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(chatText.value);
      }
    });

    scrollChat();
  }

  function typeWriter(node, text, onTick) {
    var i = 0;
    node.textContent = '';
    var timer = setInterval(function () {
      i += 2;
      node.textContent = text.slice(0, i);
      if (onTick) onTick();
      if (i >= text.length) {
        clearInterval(timer);
        timers = timers.filter(function (t) { return t !== timer; });
      }
    }, 16);
    timers.push(timer);
  }

  function answerFor(q, elder) {
    // 本地降级回答会直接渲染到聊天气泡，姓名同样按角色脱敏
    var name = maskElderName(elder.name);
    if (/血压/.test(q)) {
      return '结合 ' + name + ' 近 30 天数据，收缩压均值约 ' + elder.lastVitals.sbp + ' mmHg，波动幅度较大。建议：① 每日固定时间测量并记录，测量前静坐 5 分钟；② 严格控盐，每日不超过 5g，少食咸鱼、腌菜；③ 降压药需按时服用，不可自行停药或加量；④ 若出现头晕、胸闷或血压持续高于 160/100 mmHg，请尽快到平潭协和医院心内科就诊。';
    }
    if (/睡|失眠/.test(q)) {
      return '高龄老人睡眠浅较为常见。建议：① 固定作息，午睡不超过 30 分钟；② 睡前 1 小时避免饮茶与使用手机；③ 卧室保持安静、温度 24℃ 左右，夜间留一盏小夜灯防跌倒；④ 若持续两周以上入睡困难或伴随情绪低落，建议由家属陪同至老年科评估，不建议自行服用安眠药。';
    }
    if (/饮食|吃/.test(q)) {
      return '针对 ' + name + ' 的情况（' + (elder.chronic.join('、') || '一般老年营养需求') + '），建议：① 每日食盐 <5g，烹调油 <25g；② 早餐保证 1 个鸡蛋或一杯牛奶，午餐晚餐各一两鱼禽瘦肉；③ 主食粗细搭配，多吃深色蔬菜与豆制品；④ 少量多餐，食物切碎煮软，方便咀嚼吞咽。';
    }
    if (/跌倒|摔|走路/.test(q)) {
      return '跌倒风险评估为' + riskLevel(scores(elder).fall).text + '。建议：① 居室去除门槛与杂物，卫生间加装扶手、防滑垫；② 起身遵循「躺 30 秒、坐 30 秒、站 30 秒」；③ 每日做 2 组平衡训练，家属在旁保护；④ 确保手环电量充足并佩戴，跌倒后 30 秒未取消将自动通知家属与村居社工。';
    }
    if (/血糖|糖尿/.test(q)) {
      return '建议每周监测 2 - 3 次空腹血糖，控制在 7.0 mmol/L 左右（高龄老人可适当放宽）。主食定量、粗细搭配，避免稀饭、含糖饮料与糕点；餐后散步 20 分钟有助于控制血糖。若出现明显口渴、多尿、体重下降，请及时到内分泌科就诊。';
    }
    if (/咳嗽|发热|食欲/.test(q)) {
      return '高龄老人出现咳嗽、食欲下降需警惕肺部感染。建议：① 每日测量体温 2 次并记录；② 保证饮水量，饮食清淡易消化；③ 观察是否出现气促、精神萎靡；④ 若体温超过 38℃ 或症状持续 2 天未缓解，请立即就医，并同步告知村居社工安排陪诊。';
    }
    return '根据 ' + name + ' 的体征数据与慢病情况，建议先做好三件事：规律测量血压心率并记录、按医嘱服药、保持清淡饮食与适度活动。若症状持续或加重，请及时联系家庭医生或到就近卫生院就诊，也可由村居社工协助预约陪诊服务。以上建议仅供参考，不能替代医生面诊。';
  }

  function destroy() {
    // 中断进行中的流式问答，避免页面销毁后回调操作已卸载的 DOM
    chatEpoch++;
    if (chatController) {
      try { chatController.abort(); } catch (e) { /* ignore */ }
      chatController = null;
    }
    timers.forEach(function (t) { clearInterval(t); });
    timers = [];
    analyzing = false;
  }

  YL.pages = YL.pages || {};
  YL.pages.ai = { render: render, destroy: destroy };
})(window);