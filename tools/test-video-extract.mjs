// 复刻 content.js 中的解析逻辑做离线验证：node tools/test-video-extract.mjs
function mediaIdsFor(tweetId, posters) {
  const ids = [];
  if (tweetId) ids.push(tweetId);
  for (const p of posters || []) {
    const m = /(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d{5,25})\//.exec(String(p || ''));
    if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  return ids;
}

function buildMediaIdMatcher(ids) {
  const parts = ids.map((id) => '(?:ext_tw_video|amplify_video)\\/' + id + '\\/');
  return new RegExp('(?:' + parts.join('|') + ')');
}

function videoUrlsFromDom(matcher, scripts) {
  const matched = [];
  const groups = new Map();
  for (const t of scripts) {
    if (t.indexOf('video.twimg.com') === -1) continue;
    const raw = t.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    const re = /https:\/\/video\.twimg\.com\/[^\s"'\\<>) ]+/g;
    let m;
    while ((m = re.exec(raw))) {
      const u = m[0];
      if (!/\.mp4(\?|$)/.test(u)) continue;
      const vm = /(?:ext_tw_video|amplify_video)\/(\d{5,25})\//.exec(u);
      if (!vm) continue;
      const vid = vm[1];
      if (!groups.has(vid)) groups.set(vid, []);
      if (groups.get(vid).indexOf(u) === -1) groups.get(vid).push(u);
      if (matcher && matcher.test(u) && matched.indexOf(u) === -1) matched.push(u);
    }
  }
  if (matched.length) return matched;
  const groupList = Array.from(groups.values());
  if (groupList.length === 1) return groupList[0];
  return [];
}

function pickByResolution(urls) {
  let best = null;
  let bestScore = -1;
  for (const u of urls) {
    const m = /\/vid\/[^/]+\/(\d+)x(\d+)\//.exec(u);
    const area = m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
    const score = area * 2 + (/\/avc1\//.test(u) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best || urls[0] || null;
}

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
  if (!cond) failures++;
}

// ===== 场景 1：原生视频（ext_tw_video，URL 内是推文 ID）=====
{
  const tweetId = '111222333444555';
  const scripts = [
    '{"variants":[' +
      '{"src":"https:\\/\\/video.twimg.com\\/ext_tw_video\\/111222333444555\\/pu\\/pl\\/x.m3u8"},' +
      '{"src":"https:\\/\\/video.twimg.com\\/ext_tw_video\\/111222333444555\\/pu\\/vid\\/avc1\\/320x568\\/a.mp4?tag=12"},' +
      '{"src":"https:\\/\\/video.twimg.com\\/ext_tw_video\\/111222333444555\\/pu\\/vid\\/avc1\\/720x1280\\/b.mp4?tag=12\\u0026type=1"}]}',
    'noise https://video.twimg.com/ext_tw_video/999888777666/pu/vid/avc1/1080x1920/other.mp4',
  ];
  const ids = mediaIdsFor(tweetId, ['https://pbs.twimg.com/ext_tw_video_thumb/111222333444555/pu/img/x.jpg']);
  const matcher = buildMediaIdMatcher(ids);
  const urls = videoUrlsFromDom(matcher, scripts);
  check('ext_tw_video: 提取 2 个 mp4（排除 m3u8 与他人视频）', urls.length === 2);
  check('ext_tw_video: 选最高分辨率', pickByResolution(urls).includes('720x1280'));
}

// ===== 场景 2：amplify 视频（URL 内是媒体 ID ≠ 推文 ID，与封面 ID 一致）=====
{
  const tweetId = '2082003734478065840';
  const poster = 'https://pbs.twimg.com/amplify_video_thumb/2082003538151141376/img/3-aEEXfmH7I7rpln.jpg?name=orig';
  const scripts = [
    '{"variants":[' +
      '{"src":"https:\\/\\/video.twimg.com\\/amplify_video\\/2082003538151141376\\/vid\\/avc1\\/640x360\\/a.mp4?tag=12"},' +
      '{"src":"https:\\/\\/video.twimg.com\\/amplify_video\\/2082003538151141376\\/vid\\/avc1\\/1280x720\\/b.mp4?tag=12"},' +
      '{"src":"https:\\/\\/video.twimg.com\\/amplify_video\\/2082003538151141376\\/pl\\/stream.m3u8"}]}',
  ];
  const ids = mediaIdsFor(tweetId, [poster]);
  check('amplify: 从封面提取到媒体 ID', ids.includes('2082003538151141376') && ids.includes(tweetId));
  const matcher = buildMediaIdMatcher(ids);
  const urls = videoUrlsFromDom(matcher, scripts);
  check('amplify: 按媒体 ID 匹配到 2 个 mp4', urls.length === 2);
  check('amplify: 选 1280x720', pickByResolution(urls).includes('1280x720'));
}

// ===== 场景 3：ID 完全对不上，但页面只有一组视频 → 唯一组兜底 =====
{
  const scripts = ['{"x":"https:\\/\\/video.twimg.com\\/ext_tw_video\\/777777777777777\\/pu\\/vid\\/avc1\\/640x360\\/only.mp4?tag=1"}'];
  const matcher = buildMediaIdMatcher(mediaIdsFor('12345', []));
  const urls = videoUrlsFromDom(matcher, scripts);
  check('唯一组兜底: 返回唯一的视频', urls.length === 1 && urls[0].includes('777777777777777'));
}

// ===== 场景 4：多组视频且 ID 不匹配 → 不猜 =====
{
  const scripts = [
    'https://video.twimg.com/ext_tw_video/111111111111111/pu/vid/avc1/640x360/a.mp4',
    'https://video.twimg.com/amplify_video/222222222222222/vid/avc1/640x360/b.mp4',
  ].map((u) => '{"u":"' + u + '"}');
  const matcher = buildMediaIdMatcher(mediaIdsFor('99999999999', []));
  const urls = videoUrlsFromDom(matcher, scripts);
  check('多组不匹配: 返回空（不乱猜）', urls.length === 0);
}

console.log(failures === 0 ? '\n全部通过' : '\n有 ' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
