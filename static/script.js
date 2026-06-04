// 1. ALL IMPORTS MUST BE AT THE ABSOLUTE TOP OF THE FILE
import StrShuffler from './lib/StrShuffler.js';
import Api from './lib/api.js';

// 2. POLYFILL RUNS DIRECTLY AFTER IMPORTS
// 
(function() {
  const patchObject = (obj) => {
    if (!obj) return;
    try {
      if (!obj.hasOwnProperty('addChangeEventListener') && !obj.addChangeEventListener) {
        Object.defineProperty(obj, 'addChangeEventListener', {
          value: function(f) { 
            if (!this._evs) this._evs = [];
            if (!this._evs.includes(f)) this._evs.push(f); 
          },
          writable: true, enumerable: false, configurable: true
        });
      }
      if (!obj.hasOwnProperty('removeChangeEventListener') && !obj.removeChangeEventListener) {
        Object.defineProperty(obj, 'removeChangeEventListener', {
          value: function(f) { 
            if (this._evs) this._evs = this._evs.filter(x => x !== f); 
          },
          writable: true, enumerable: false, configurable: true
        });
      }
    } catch(e) {}
  };

  patchObject(Object.prototype);
  patchObject(EventTarget.prototype);
  if (typeof Node !== 'undefined') patchObject(Node.prototype);
  if (typeof Element !== 'undefined') patchObject(Element.prototype);
  patchObject(window);
})();

function setError(err) {
    var element = document.getElementById('error-text');
    if (err) {
        element.style.display = 'block';
        element.textContent = 'An error occurred: ' + err;
    } else {
        element.style.display = 'none';
        element.textContent = '';
    }
}

window.addEventListener('error', setError);

(function () {
    const api = new Api();
    var localStorageKey = 'rammerhead_sessionids';
    var localStorageKeyDefault = 'rammerhead_default_sessionid';

    var sessionIdsStore = {
        get() {
            var rawData = localStorage.getItem(localStorageKey);
            if (!rawData) return [];
            try {
                var data = JSON.parse(rawData);
                if (!Array.isArray(data)) throw new Error('Invalid data');
                return data;
            } catch (e) {
                return [];
            }
        },
        set(data) {
            if (!data || !Array.isArray(data)) throw new TypeError('Must be array');
            localStorage.setItem(localStorageKey, JSON.stringify(data));
        },
        getDefault() {
            var sessionId = localStorage.getItem(localStorageKeyDefault);
            if (sessionId) {
                var data = sessionIdsStore.get();
                var filteredData = data.filter(function (e) {
                    return e.id === sessionId;
                });
                if (filteredData.length) return filteredData[0];
            }
            return null;
        },
        setDefault(id) {
            localStorage.setItem(localStorageKeyDefault, id);
        }
    };

    function renderSessionTable(data) {
        var tbody = document.querySelector('tbody');
        while (tbody.firstChild && tbody.firstChild.remove()) {}

        for (var i = 0; i < data.length; i++) {
            var tr = document.createElement('tr');
            appendIntoTr(data[i].id, tr);
            appendIntoTr(data[i].createdOn, tr);

            var fillInBtn = document.createElement('button');
            fillInBtn.textContent = 'Fill in existing session ID';
            fillInBtn.className = 'btn btn-outline-primary';
            fillInBtn.onclick = index(i, function (idx) {
                setError();
                if (data && data[idx]) {
                    sessionIdsStore.setDefault(data[idx].id);
                    loadSettings(data[idx]);
                }
            });
            appendIntoTr(fillInBtn, tr);

            var deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'btn btn-outline-danger';
            deleteBtn.onclick = index(i, function (idx) {
                setError();
                if (data && data[idx]) {
                    api.deletesession(data[idx].id).then(() => {
                        data.splice(idx, 1);
                        sessionIdsStore.set(data);
                        renderSessionTable(data);
                    });
                }
            });
            appendIntoTr(deleteBtn, tr);

            tbody.appendChild(tr);
        }

        function appendIntoTr(stuff, row) {
            var td = document.createElement('td');
            if (typeof stuff === 'object') {
                td.appendChild(stuff);
            } else {
                td.textContent = stuff;
            }
            row.appendChild(td);
        }

        function index(i, func) {
            return func.bind(null, i);
        }
    }

    function loadSettings(session) {
        document.getElementById('session-id').value = session.id || '';
        document.getElementById('session-httpproxy').value = session.httpproxy || '';
        document.getElementById('session-shuffling').checked = typeof session.enableShuffling === 'boolean' ? session.enableShuffling : true;
    }

    function loadSessions() {
        var sessions = sessionIdsStore.get();
        var defaultSession = sessionIdsStore.getDefault();
        if (defaultSession) loadSettings(defaultSession);
        renderSessionTable(sessions);
    }

    function addSession(id) {
        var data = sessionIdsStore.get();
        data.unshift({ id: id, createdOn: new Date().toLocaleString() });
        sessionIdsStore.set(data);
        renderSessionTable(data);
    }

    function editSession(id, httpproxy, enableShuffling) {
        var data = sessionIdsStore.get();
        for (var i = 0; i < data.length; i++) {
            if (data[i].id === id) {
                data[i].httpproxy = httpproxy;
                data[i].enableShuffling = enableShuffling;
                sessionIdsStore.set(data);
                return;
            }
        }
        throw new TypeError('Cannot find ' + id);
    }

    api.get('/mainport').then((data) => {
        var isReverseProxy = (
            !window.location.port ||                                  // default port = proxy host
            window.location.hostname.includes('ngrok') ||            // any ngrok domain
            window.location.hostname.includes('onrender.com') ||     // Render
            window.location.hostname.includes('railway.app') ||      // Railway
            window.location.hostname.includes('up.railway.app') ||   // Railway alt
            window.location.hostname.includes('herokuapp.com') ||    // Heroku
            window.location.hostname.includes('vercel.app') ||       // Vercel
            window.location.hostname.includes('fly.dev') ||          // Fly.io
            window.location.hostname.includes('pages.dev') ||        // Cloudflare Pages
            window.location.hostname.includes('workers.dev') ||      // Cloudflare Workers
            window.location.hostname.includes('trycloudflare.com')   // Cloudflare Tunnel
        );
        if (isReverseProxy) {
            console.log('[RH] Reverse-proxy host detected — port switching bypassed.');
            return;
        }
        var defaultPort = window.location.protocol === 'https:' ? 443 : 80;
        var currentPort = parseInt(window.location.port) || defaultPort;
        var mainPort = parseInt(data) || defaultPort;
        if (currentPort !== mainPort) {
            console.log('[RH] Redirecting to port ' + mainPort);
            window.location.port = mainPort;
        }
    });

    api.needpassword().then(doNeed => {
        if (doNeed) {
            document.getElementById('password-wrapper').style.display = 'block';
        }
    });

    window.addEventListener('load', function () {
        loadSessions();
        var showingAdvancedOptions = false;

        document.getElementById('session-advanced-toggle').onclick = function () {
            document.getElementById('session-advanced-container').style.display = (showingAdvancedOptions = !showingAdvancedOptions) ? 'block' : 'none';
        };

        document.getElementById('session-create-btn').addEventListener('click', () => {
            setError();
            api.newsession().then((id) => {
                addSession(id);
                document.getElementById('session-id').value = id;
                document.getElementById('session-httpproxy').value = '';
            });
        });

        async function go() {
            setError();
            const id = document.getElementById('session-id').value;
            const httpproxy = document.getElementById('session-httpproxy').value;
            
            const enableShuffling = document.getElementById('session-shuffling').checked;
            let url = document.getElementById('session-url').value;

            if (!id) return setError('Must select or create a session first');
            if (!url) return setError('Must provide a URL to go to');

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'http://' + url;
            }

            try {
                // Ensure the ID is clean and stripped of accidental whitespace
                const cleanId = id.trim();

                await api.editsession(cleanId, httpproxy, enableShuffling);
                editSession(cleanId, httpproxy, enableShuffling);

                if (enableShuffling) {
                    const shuffleDictStr = await api.get('/api/shuffleDict?id=' + cleanId);
                    const shuffleDict = JSON.parse(shuffleDictStr);
                    const shuffler = new StrShuffler(shuffleDict);
                    
                    const shuffledUrl = shuffler.shuffle(url);
                    window.location.href = '/' + cleanId + '/' + shuffledUrl;
                } else {
                    window.location.href = '/' + cleanId + '/' + url;
                }
            } catch (err) {
                setError(err.message || err);
            }
        }

        document.getElementById('session-go').onclick = go;
        document.getElementById('session-url').onkeydown = function (e) {
            if (e.key === 'Enter') go();
        };
    });
})();
