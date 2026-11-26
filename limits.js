(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NightfallLimits=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SPEECH_CHAR_LIMIT=1400;
  const AGENT_OUTPUT_MAX_TOKENS=25000;
  const SPEECH_OUTPUT_MAX_TOKENS=AGENT_OUTPUT_MAX_TOKENS;
  const ACTION_OUTPUT_MAX_TOKENS=AGENT_OUTPUT_MAX_TOKENS;
  const CONNECTION_TEST_OUTPUT_MAX_TOKENS=350;
  const SPEECH_ATTEMPT_TIMEOUT_MS=90000;
  const SPEECH_UPSTREAM_TIMEOUT_MS=275000;
  const SPEECH_BROWSER_TIMEOUT_MS=280000;
  const SPEECH_READING_MAX_MS=280000;
  const AGENT_UPSTREAM_TIMEOUT_MS=180000;
  const AGENT_CONNECTION_TIMEOUT_MS=20000;
  const AGENT_BROWSER_TIMEOUT_MS=185000;
  function unicodeLength(value){return Array.from(String(value??'')).length}
  function truncateUnicode(value,limit=SPEECH_CHAR_LIMIT){return Array.from(String(value??'')).slice(0,limit).join('')}
  return {AGENT_OUTPUT_MAX_TOKENS,SPEECH_CHAR_LIMIT,SPEECH_OUTPUT_MAX_TOKENS,ACTION_OUTPUT_MAX_TOKENS,CONNECTION_TEST_OUTPUT_MAX_TOKENS,SPEECH_ATTEMPT_TIMEOUT_MS,SPEECH_UPSTREAM_TIMEOUT_MS,SPEECH_BROWSER_TIMEOUT_MS,SPEECH_READING_MAX_MS,AGENT_UPSTREAM_TIMEOUT_MS,AGENT_CONNECTION_TIMEOUT_MS,AGENT_BROWSER_TIMEOUT_MS,unicodeLength,truncateUnicode};
});
