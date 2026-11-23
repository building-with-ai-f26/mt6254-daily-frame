// PostHog analytics for the local app. Settings come from /config.js (served by server.py from .env).
// Privacy: photos, reflections and the weather location are hidden in session replays
// (class "ph-no-capture" blocks an element; inputs are masked), so replays show clicks and layout only.
(function () {
  const cfg = window.DF_CONFIG || {};
  window.track = function () {}; // no-op until PostHog is set up
  if (!cfg.posthogKey) return;

  /* PostHog web snippet */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  posthog.init(cfg.posthogKey, {
    api_host: cfg.posthogHost || 'https://us.i.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: true,
    autocapture: true, // clicks
    session_recording: { maskAllInputs: true, maskTextSelector: '.ph-mask' },
  });
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  posthog.register({ surface: local ? 'local_app' : 'live_app' });

  // Named events for the core workflow. Never send reflection text or photos, only counts and flags.
  window.track = function (event, props) {
    try { posthog.capture(event, props || {}); } catch (_) {}
  };
})();
