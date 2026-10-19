function getWeatherPrivateSources_(body) {
  requireKey_(body.adminKey,adminKey_(),'管理キー');
  const props=PropertiesService.getScriptProperties();
  let raw=props.getProperty('WEATHER_PRIVATE_SOURCE_HANDLES');
  if(!raw && typeof weatherPrivateSourceDefaults_==='function') {
    raw=JSON.stringify(weatherPrivateSourceDefaults_());
    props.setProperty('WEATHER_PRIVATE_SOURCE_HANDLES',raw);
  }
  let handles;
  try {handles=JSON.parse(raw || '[]');} catch(_) {throw new Error('Private weather sources are invalid');}
  if(!Array.isArray(handles) || handles.length>10 || handles.some(function(h){return typeof h!=='string' || !/^[A-Za-z0-9_]{1,15}$/.test(h);})) throw new Error('Private weather sources are invalid');
  return json_({ok:true,handles:handles});
}
