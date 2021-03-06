const {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  session,
} = require('electron');
const { join } = require('path');
const UUID = require('uuid');
const _ = require('lodash');
const { EventEmitter2 } = require('eventemitter2');

class Window extends EventEmitter2 {
  constructor(core, opts, callback = function() {}) {
    super({
      wildcard: true,
      newListener: false,
      maxListeners: opts.maxListeners || 500,
    });
    let _this = this;
    this.log = core.log;
    this.instance = null;
    this.session = UUID.v4();
    this.callback = callback;

    if (opts.size) {
      let split = opts.size.split('x');
      opts.fullscreen = false;
      opts.kiosk = false;
      opts.width = Number(split[0]);
      opts.height = Number(split[1]);
    }

    this.opts = _.defaultsDeep(opts || {}, {
      title: 'OAK',
      userAgent: 'Oak/' + core.version,
      icon: join(__dirname, '..', 'icon.png'),
      enableLargerThanScreen: true,
      display: 0,
      width: 1024,
      height: 768,
      x: 0,
      y: 0,
      background: '#000000',
      fullscreen: true,
      kiosk: true,
      ontop: true,
      frame: false,
      shortcut: {
        reload: false,
        quit: false,
      },
      debugger: false,
      show: true,
      node: false,
      insecure: false,
    });

    session.defaultSession.setUserAgent(this.opts.userAgent);

    let displays = screen.getAllDisplays();
    this.display =
      this.opts.display > displays.length - 1
        ? displays[0]
        : displays[this.opts.display];

    if (this.opts.fullscreen) {
      this.opts.width = this.display.workArea.width;
      this.opts.height = this.display.workArea.height;
    }

    this.instance = new BrowserWindow({
      title: _this.opts.title,
      webPreferences: {
        nodeIntegration: _this.opts.node,
        nodeIntegrationInWorker: _this.opts.node,
        webSecurity: !_this.opts.insecure,
        allowRunningInsecureContent: _this.opts.insecure,
        devTools: true,
        preload: join(__dirname, 'preload'),
      },
      width: _this.opts.width,
      height: _this.opts.height,
      x: _this.opts.x,
      y: _this.opts.y,
      hasShadow: false,
      alwaysOnTop: _this.opts.ontop,
      backgroundColor: _this.opts.background,
      frame: _this.opts.frame,
      kiosk: _this.opts.kiosk,
      show: _this.opts.show,
    });

    this.id = this.instance.id;

    if (opts.shortcut.reload) {
      globalShortcut.register('CommandOrControl+Shift+R', () => {
        return _this.instance.isFocused() && _this.reload();
      });
    }
    if (opts.shortcut.quit) {
      globalShortcut.register('CommandOrControl+Shift+X', () => {
        _this.instance.isFocused() && _this.instance.close();
      });
    }

    this.instance
      .on('closed', () => {
        _this.instance = null;
      })
      .on('ready-to-show', () => {
        if (_this.opts.debugger) {
          _this.debug();
        }
      })
      .on('unresponsive', function() {
        _this.emit('unresponsive');
      })
      .on('responsive', function() {
        _this.emit('responsive');
      });

    this.instance.webContents
      .on('dom-ready', () => {
        // sending our optional scripts to the preload window listener
        _this.send('_scriptsToInject', _this.opts.scripts);
        _this.send('dom-ready');
      })
      .on('crashed', () => _this.emit('crashed'));

    ipcMain
      .on('_window', function() {
        filterWindow(...[_this.emit, ...arguments]);
      })
      .on('_location', function() {
        filterWindow(...[_this.location, ...arguments]);
      })
      .on('_reload', function() {
        filterWindow(...[_this.reload, ...arguments]);
      })
      .on('_debug', function() {
        filterWindow(...[_this.debug, ...arguments]);
      })
      .on('_hide', function() {
        filterWindow(...[_this.hide, ...arguments]);
      })
      .on('_show', function() {
        filterWindow(...[_this.show, ...arguments]);
      })
      .on('_focus', function() {
        filterWindow(...[_this.focus, ...arguments]);
      })
      .on('_close', function() {
        filterWindow(...[_this.focus, ...arguments]);
      })
      .on('_ready', function() {
        filterWindow(...[_this.ready, ...arguments]);
      });

    function filterWindow(fn, ev) {
      if (ev.sender.id === _this.id) {
        fn.call(_this, ...[...arguments].splice(2, arguments.length));
      }
    }

    this._bindInstanceEvents();
    this.loadPage();

    return this;
  }

  _bindInstanceEvents() {
    let _this = this;
    if (!_.isNull(this.instance)) {
      let id = _this.instance.id;
      // store the previous emit methods
      let instanceEmitter = this.instance.emit;
      let contentsEmitter = this.instance.webContents.emit;
      // override window emit method
      this.instance.emit = function(ev, ee, data) {
        // fire original event on our emitter
        _this.emit(ev, data);
        _this.log.debug('instance', {
          name: ev,
          data,
          id,
        });
        // fire event at the original emit method
        instanceEmitter.apply(_this.instance, arguments);
      };
      // same as above, but for webContents
      this.instance.webContents.emit = function(ev, ee, data) {
        if (ev.indexOf('ipc') === -1) {
          _this.emit(ev, data);
          _this.log.debug('contents', {
            name: ev,
            data,
            id,
          });
        }
        if (!_.isNull(_this.instance)) {
          contentsEmitter.apply(_this.instance.webContents, arguments);
        }
      };
    }
    return this;
  }

  loadPage(newUrl = false) {
    // load a new URL, or default to the original options url
    this.instance.loadURL(newUrl || this.opts.url);
    return this;
  }

  newSession(_id = UUID.v4()) {
    this.session = _id;
    return this.session;
  }

  location(newUrl) {
    let oldSession = this.session;
    let newSession = this.newSession();
    // keep old url
    let oldUrl = this.instance.webContents.getURL();
    this.loadPage(newUrl);
    // fetch resolved new url
    newUrl = this.instance.webContents.getURL();
    this.emit(
      'location',
      { url: oldUrl, session: oldSession },
      { url: newUrl, session: newSession },
    );
    return this;
  }

  reload(cache = true) {
    // save the old session
    let oldSession = this.session;
    // start new session
    let newSession = this.newSession();
    cache
      ? this.instance.webContents.reload()
      : this.instance.webContents.reloadIgnoringCache();
    this.emit('reload', oldSession, newSession);
    return this;
  }

  ready() {
    let _this = this;
    this.emit('ready');
    this.callback.call(_this, null);
    return this;
  }

  send() {
    if (arguments.length > 0) {
      this.instance.webContents.send(...[...arguments]);
      return this;
    } else {
      return new Error('You must specify an event name as the first parameter');
    }
  }

  debug() {
    let c = this.instance.webContents;
    c.isDevToolsOpened() ? c.closeDevTools() : c.openDevTools();
    return this;
  }

  hide() {
    this.instance.hide();
    return this;
  }

  show() {
    this.instance.show();
    return this;
  }

  focus() {
    this.instance.focus();
    return this;
  }

  isFocused() {
    this.instance.isFocused();
    return this;
  }

  close() {
    this.instance.close();
    return this;
  }
}

module.exports = Window;
