(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NightfallAPIWait=api})(globalThis,()=>{
  const permanent=new Set(['AUTH_FAILED','QUOTA_EXCEEDED','MODEL_UNAVAILABLE','ACCESS_DENIED','ENDPOINT_NOT_FOUND','INVALID_ENDPOINT','INVALID_CONFIG','INVALID_REASONING_EFFORT','REASONING_EFFORT_UNSUPPORTED','INVALID_AGENT_RESPONSE','INVALID_RESPONSE','AGENT_OUTPUT_TRUNCATED']);
  function retryable(error){return !permanent.has(error.code)&&![400,401,402,403,404,405].includes(error.status)}
  function delay(attempt){return [5000,10000,20000,30000][Math.min(Math.max(0,attempt-1),3)]}
  return {retryable,delay};
});


