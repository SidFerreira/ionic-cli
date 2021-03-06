var Task = require('./task').Task,
    IonicStats = require('./stats').IonicStats,
    fs = require('fs'),
    Q = require('q'),
    argv = require('optimist').argv,
    xml2js = require('xml2js'),
    path = require('path'),
    exec = require('child_process').exec,
    colors = require('colors');

var IonicTask = function() {};

IonicTask.prototype = new Task();

IonicTask.prototype.run = function(ionic) {
  this.ionic = ionic;
  var self = this;
  var cmdName = process.argv[2].toLowerCase();
  var q;

  this.isLiveReload = ((cmdName == 'run' || cmdName == 'emulate') && (argv.livereload || argv['live-reload'] || argv.l));

  if(this.isLiveReload) {
    q = self.setupLiveReload();

  } else {
    // ensure the content node was set back to its original
    q = this.setConfigXml({
      resetContent: true,
      errorWhenNotFound: false
    });
  }

  q.then(function(){
    self.runCordova(cmdName);
  })
};


IonicTask.prototype.runCordova = function(cmdName) {
  var self = this;
  var cmdArgs = (process.argv.length > 3 ? process.argv.slice(3) : []);
  var cmdArg, x, y;

  // backwards compatibility prior to fully wrapping cordova cmds
  if(cmdName == 'platform') {
    // `ionic platform <PLATFORM>` used to actually run `ionic platform add <PLATFORM>`
    // if a cordova platform cmd isn't the cmd then automatically insert `add`
    var hasCordovaCmd = false;
    var validCommands = 'add remove rm list ls update up check'.split(' ');
    for(x=0; x<cmdArgs.length; x++) {
      cmdArg = cmdArgs[x].toLowerCase();
      for(y=0; y<validCommands.length; y++) {
        if(cmdArg == validCommands[y]) {
          hasCordovaCmd = true;
          break;
        }
      }
    }
    if(!hasCordovaCmd) {
      cmdArgs.unshift('add');
    }
  }
  this.addHooks();

  cmdArgs.unshift(cmdName);

  // clean out any cmds that may confuse cordova
  var cleanArgs = [];
  var port = argv.port || argv.p || '';
  var liveReloadPort = argv.livereloadport || argv['livereload-port'] || argv.i || '';
  var ignoreCmds = '--livereload -l --consolelogs -c --serverlogs -s --port -p --livereload-port -i'.split(' ');
  var isValdCmd;
  for(x=0; x<cmdArgs.length; x++) {
    cmdArg = cmdArgs[x];
    if(port && cmdArg == port) continue;
    if(liveReloadPort && cmdArg == liveReloadPort) continue;
    isValdCmd = true;
    for(y=0; y<ignoreCmds.length; y++) {
      if(cmdArg == ignoreCmds[y]) {
        isValdCmd = false;
        break;
      }
    }
    if(isValdCmd) {
      cleanArgs.push(cmdArg);
    }
  }

  var cordovaProcess = exec('cordova ' + cleanArgs.join(' '));

  cordovaProcess.stdout.on('data', function (data) {
    process.stdout.write(data);
  });

  cordovaProcess.stderr.on('data', function (data) {
    if(data) {
      process.stderr.write(data.toString().error.bold);
    }
  });

  if(self.isLiveReload) {
    cordovaProcess.on('exit', function(){
      setTimeout(function(){
        // set it back to the original src after a few seconds
        self.setConfigXml({
          resetContent: true,
          errorWhenNotFound: true
        });
      }, 5000);
    });

    process.on('exit', function(){
      // verify it was set back
      self.setConfigXml({
        resetContent: true,
        errorWhenNotFound: false
      });
    });
  }

  IonicStats.t();
};


IonicTask.prototype.setupLiveReload = function() {
  var d = Q.defer();

  console.log('Setup Live Reload'.green.bold);

  var self = this;
  var serve = new require('./serve');
  var serveTask = new serve.IonicTask();
  serveTask.ionic = this.ionic;
  serveTask.isPlatformServe = true;

  serveTask.loadSettings(function(){
    serveTask.runLivereload = true;
    serveTask.launchBrowser = false;
    serveTask.start(self.ionic);

    self.setConfigXml({
      devServer: serveTask.devServer
    }).then(function(){
      d.resolve();
    });

  });

  return d.promise;
};


IonicTask.prototype.setConfigXml = function(options) {
  var d = Q.defer();

  var self = this;
  var madeChange = false;

  try {
    var configXmlPath = path.resolve('config.xml');

    if(!fs.existsSync(configXmlPath)) {
      // working directory does not have the config.xml file
      if(options.errorWhenNotFound) {
        d.reject('Unable to locate config.xml file. Please ensure the working directory is at the root of the app where the config.xml should be located.');
      } else {
        d.resolve();
      }
      return d.promise;
    }

    var configString = fs.readFileSync(configXmlPath, { encoding: 'utf8' });

    var parseString = xml2js.parseString;
    parseString(configString, function (err, jsonConfig) {
      if(err) {
        d.reject(err);
        return self.ionic.fail('Error parsing ' + configXmlPath + ': ' + err);
      }

      if(options.devServer) {
        if( !jsonConfig.widget.content[0].$['original-src'] ) {
          jsonConfig.widget.content[0].$['original-src'] = jsonConfig.widget.content[0].$.src;
          madeChange = true;
        }
        if(jsonConfig.widget.content[0].$.src !== options.devServer) {
          jsonConfig.widget.content[0].$.src = options.devServer;
          madeChange = true;
        }

      } else if(options.resetContent) {

        if( jsonConfig.widget.content[0].$['original-src'] ) {
          jsonConfig.widget.content[0].$.src = jsonConfig.widget.content[0].$['original-src'];
          delete jsonConfig.widget.content[0].$['original-src'];
          madeChange = true;
        }
      }

      if(madeChange) {
        var xmlBuilder = new xml2js.Builder();
        configString = xmlBuilder.buildObject(jsonConfig);
        fs.writeFileSync(configXmlPath, configString);
      }

      d.resolve();
    });

  } catch(e) {
    d.reject(e);
    self.ionic.fail('Error updating ' + configXmlPath + ': ' + e);
  }

  return d.promise;
};


IonicTask.prototype.addHooks = function() {
  // Add hooks which this Ionic project doesn't already have
  // note: hook scripts must be executable!

  if( !fs.existsSync(path.join('www')) ) {
    // don't both doing any of this if they aren't
    // in the correct working directory, which would have `www`
    return;
  }

  // loop through all the hook directories added to the ionic-cli
  var cliHooksPath = path.join(__filename, '../../hooks');
  fs.readdir(cliHooksPath, function(err, files){
    if(err) return;
    for(var x=0; x<files.length; x++) {
      if(files[x].indexOf('.') > -1) continue;
      addCliHookDirectory( path.join(cliHooksPath, files[x]), files[x] );
    }
  });

  function addCliHookDirectory(cliHookPath, hookDirectoryName) {
    fs.readdir(cliHookPath, function(err, files){
      // loop through each of the scripts in the ionic-cli hook directory
      if(err) return;
      for(var x=0; x<files.length; x++) {
        var hookFilename = files[x];
        if(hookFilename.indexOf('.js') === -1) return;

        // check if this hook script has already been added to this ionic project
        var projectHookPath = path.join('hooks', hookDirectoryName, hookFilename);
        addHookScript(cliHookPath, hookDirectoryName, hookFilename);
      }
    });
  }

  function addHookScript(cliHookPath, hookDirectoryName, hookFilename) {
    // add the root hooks directory if the project doesn't have it
    try {
      var projectHookPath = path.join('hooks');
      if( !fs.existsSync(projectHookPath) ) {
        fs.mkdirSync(projectHookPath);
      }

      // add the hook directory (ie: after_prepare) if the project doesn't have it
      projectHookPath = path.join(projectHookPath, hookDirectoryName);
      if( !fs.existsSync(projectHookPath) ) {
        fs.mkdirSync(projectHookPath);
      }

      var projectScript = path.join(projectHookPath, hookFilename);
      if( !fs.existsSync(projectHookPath) ) {
        // copy the hook script to the project
        try {
          var cliScript = path.join(cliHookPath, hookFilename);
          fs.createReadStream( cliScript ).pipe(fs.createWriteStream( projectScript ));
        } catch(e) {
          console.log( ('addCliHookDirectory fs.createReadStream: ' + e).error );
          return;
        }
      }

      // make the script file executable
      try {
        fs.chmodSync(projectScript, '755');
      } catch(e) {
        console.log( ('addCliHookDirectory fs.chmodSync: ' + e).error );
      }

    } catch(e) {
      console.log('Error adding hook script ' + hookDirectoryName + '/' + hookFilename + ', ' + e);
    }
  }

};

exports.IonicTask = IonicTask;
