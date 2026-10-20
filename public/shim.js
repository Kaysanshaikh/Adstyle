/* Replaces google.script.run so the original pages work unchanged.
   Every call goes to /api/rpc on this same site. The admin PIN is kept for the
   browser session and sent with each call; the server checks it. */
(function () {
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, k) {
      if (k === 'withSuccessHandler') return function (f) { return runner(f, fail); };
      if (k === 'withFailureHandler') return function (f) { return runner(ok, f); };
      return function () {
        var args = [].slice.call(arguments), pin = '';
        try { pin = sessionStorage.getItem('adstylePin') || ''; } catch (e) {}
        fetch('/api/rpc', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin },
          body: JSON.stringify({ fn: k, args: args }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) { if (fail) fail(new Error(j.error)); return; }
          if (k === 'adminLogin') { try { sessionStorage.setItem('adstylePin', j.data ? String(args[0]) : ''); } catch (e) {} }
          if (ok) ok(j.data);
        })
        .catch(function (e) { if (fail) fail(e); });
      };
    } });
  }
  window.google = { script: { run: runner(null, null) } };
})();
