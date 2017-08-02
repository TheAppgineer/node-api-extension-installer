// Copyright 2017 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

// Default repository entries
const MANAGER_GIT = "https://github.com/TheAppgineer/roon-extension-manager.git";
const MANAGER_NAME = "roon-extension-manager";

const REPOS_GIT = "https://github.com/TheAppgineer/roon-extension-repository.git";
const REPOS_NAME = 'roon-extension-repository';

// Start index of community extensions
const COMMUNITY_INDEX = 2;

const repos_base = [{
    repository: {
        type: "git",
        url: MANAGER_GIT
    }
},
{
    repository: {
        type: "git",
        url: REPOS_GIT
    }
}];

const ACTION_INSTALL = 1;
const ACTION_UPDATE = 2;
const ACTION_UNINSTALL = 3;
const ACTION_START = 4;
const ACTION_STOP = 5;

const module_dir = 'node_modules/'
const backup_dir = 'backup/'
const perform_update = 66;

var ApiExtensionRunner = require('node-api-extension-runner');

var runner;
var extension_root;
var repos = [];
var installed = {};
var updates_list = {};
var action_queue = {};
var stdio_inherit_mode;
var self_update_pending = false;
var self_update;

var repository_cb;
var installs_cb;
var updates_cb;
var status_cb;

function ApiExtensionInstaller(callbacks, inherit_mode, self_control) {
    if (callbacks) {
        if (callbacks.repository_changed) {
            repository_cb = callbacks.repository_changed;
        }
        if (callbacks.installs_changed) {
            installs_cb = callbacks.installs_changed;
        }
        if (callbacks.updates_changed) {
            updates_cb = callbacks.updates_changed;
        }
        if (callbacks.status_changed) {
            status_cb = callbacks.status_changed;
        }
    }

    if (inherit_mode) {
        stdio_inherit_mode = inherit_mode;
    } else {
        stdio_inherit_mode = 'ignore';
    }

    self_update = self_control;

    if (_check_prerequisites()) {
        _query_installs((installed) => {
            const mkdirp = require('mkdirp');

            // Create backup directory, used during update
            mkdirp(extension_root + backup_dir, (err, made) => {
                if (err) {
                    console.log(err);
                }
            });

            if (!installed[REPOS_NAME]) {
                // Install extension repository
                _queue_action(REPOS_NAME, { action: ACTION_INSTALL, url: REPOS_GIT });
            } else {
                _load_repository();
            }

            runner = new ApiExtensionRunner((running) => {
                for (let i = 0; i < running.length; i++) {
                    _start(running[i]);
                }
            });
        });

        _query_updates();
    }
}

ApiExtensionInstaller.prototype.install = function(repos_index) {
    const url = repos[repos_index].repository.url;

    _queue_action(_get_name_from_url(url), { action: ACTION_INSTALL, url: url });
}

ApiExtensionInstaller.prototype.uninstall = function(repos_index) {
    _queue_action(_get_name(repos_index), { action: ACTION_UNINSTALL });
}

ApiExtensionInstaller.prototype.update = function(repos_index) {
    _query_updates(_queue_updates, _get_name(repos_index));
}

ApiExtensionInstaller.prototype.update_all = function() {
    _query_updates(_queue_updates);
}

ApiExtensionInstaller.prototype.has_update = function(repos_index) {
    return updates_list[_get_name(repos_index)];
}

ApiExtensionInstaller.prototype.start = function(repos_index) {
    _start(_get_name(repos_index));
}

ApiExtensionInstaller.prototype.stop = function(repos_index) {
    _stop(_get_name(repos_index), true);
}

ApiExtensionInstaller.prototype.restart_manager = function() {
    _stop(MANAGER_NAME, false, () => {
        _start(MANAGER_NAME);
    });
}

/**
 * Returns the status of an extension identified by name
 *
 * @param {String} name - The name of the extension according to its package.json file
 * @returns {('not_installed'|'installed'|'stopped'|'running')} - The current status of the extension
 */
ApiExtensionInstaller.prototype.get_status = function(repos_index) {
    const name = _get_name(repos_index);
    const version = installed[name];
    let state = (version ? 'installed' : 'not_installed');

    if (state == 'installed') {
        state = runner.get_status(name);
    }

    return {
        state: state,
        version: version
    };
}

ApiExtensionInstaller.prototype.get_details = function(repos_index) {
    return repos[repos_index];
}

function _check_prerequisites() {
    let execSync = require('child_process').execSync;
    let git_version = execSync('git --version').toString();
    let npm_version = execSync('npm --version').toString();

    if (git_version) {
        git_version = git_version.split(" ")[2];

        if (npm_version) {
            return true;
        }
    }

    _set_status("Please install git and npm", true);

    return false;
}

function _load_repository() {
    const fs = require('fs');
    let repos_path = extension_root + module_dir + REPOS_NAME + '/repository.json'

    fs.readFile(repos_path, 'utf8', function(err, data) {
        if (err) {
            _set_status("Extension Repository not found", true);
        } else {
            let values = [];

            repos = repos_base.concat(JSON.parse(data));

            // Collect extension names
            for (let i = COMMUNITY_INDEX; i < repos.length; i++) {
                values.push({
                    title: repos[i].display_name,
                    value: i
                });
            }

            _set_status("Extension Repository loaded", false);

            if (repository_cb) {
                repository_cb(values);
            }
        }
    });
}

function _get_name(repos_index) {
    return _get_name_from_url(repos[repos_index].repository.url);
}

function _get_name_from_url(url) {
    let substrings = url.split(':');

    if ((substrings[0]) == 'https') {
        substrings = substrings[1].split('.')
        if ((substrings[2]) == 'git') {
            substrings = substrings[1].split('/')
            return substrings[2];
        }
    }

    return null;
}

function _install(git, cb) {
    const name = _get_name_from_url(git);

    if (name) {
        _set_status("Installing: " + name + "...", false);

        let exec = require('child_process').exec;
        exec('npm install -g ' + git, (err, stdout, stderr) => {
            if (err) {
                _set_status("Installation failed: " + name, true);
                console.error(stderr);
            } else if (cb) {
                cb(name);
            }
        });
    }
}

function _register_installed_version(name) {
    _register_version(name, false);
}

function _register_updated_version(name) {
    _register_version(name, true);
}

function _register_version(name, update) {
    _query_installs((installed) => {
        const version = installed[name];
        _set_status((update ? "Updated: " : "Installed: ") + name + " (" + version + ")", false);

        if (name == REPOS_NAME) {
            _load_repository();
        } else if (update) {
            if (!self_update_pending && runner.get_status(name) != 'stopped') {
                _start(name);
            }
        } else {
            _start(name);
        }

        _remove_action(name);
    }, name);   // Query installed extension to obtain version number

    _query_updates(null, name);
}

function _update(name, cb) {
    if (name) {
        if (self_update || name != MANAGER_NAME) {
            _set_status("Updating: " + name + "...", false);

            _stop(name, false, () => {
                const cwd = extension_root + module_dir + name + '/';
                const backup_file = extension_root + backup_dir + name + '.tar';
                const options = { file: backup_file, cwd: cwd };

                _backup(options, (clean) => {
                    let exec = require('child_process').exec;
                    exec('npm update -g ' + name, (err, stdout, stderr) => {
                        if (err) {
                            _set_status("Update failed: " + name, true);
                            console.error(stderr);
                        } else if (clean) {
                            if (cb) {
                                cb(name);
                            }
                        } else {
                            const tar = require('tar');
                            tar.extract(options, [], () => {
                                if (cb) {
                                    cb(name);
                                }
                            });
                        }
                    });
                });
            });
        } else {
            _stop(name, false, _exit_for_update);
        }
    }
}

function _backup(options, cb) {
    const fs = require('fs');
    const tar = require('tar');

    fs.readFile(options.cwd + '.npmignore', 'utf8', function(err, data) {
        let globs = [];

        if (!err) {
            const lines = data.split('\n');

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();

                if (line && line != 'node_modules' && line[0] != '#') {
                    if (fs.existsSync(options.cwd + line)) {
                        globs.push(line);
                    }
                }
            }
        }

        if (globs.length) {
            tar.create(options, globs, cb);
        } else if (cb) {
            cb(true);
        }
    });
}

function _uninstall(name, cb) {
    if (name) {
        _set_status("Uninstalling: " + name + "...", false);
        _stop(name, true);

        let exec = require('child_process').exec;
        exec('npm uninstall -g ' + name, (err, stdout, stderr) => {
            // Internal callback
            if (cb) {
                cb(name);
            }
            // User callback
            if (installs_cb) {
                installs_cb(installed);
            }
        });
    }
}

function _unregister_version(name) {
    delete installed[name];
    delete updates_list[name];

    _set_status("Uninstalled: " + name, false);
    _remove_action(name);
}

function _start(name) {
    const cwd = extension_root + module_dir + name;
    let inherit_mode = 'ignore';

    if (name == MANAGER_NAME) {
        // Pass the inherit mode to the new instance
        inherit_mode = stdio_inherit_mode;
    } else if (stdio_inherit_mode == 'inherit_all') {
        // Let the child inherit stdio streams
        inherit_mode = 'inherit';
    }

    runner.start(name, cwd, '.', inherit_mode, (code) => {
        if (code) {
            _set_status(name + " terminated unexpectedly", true);
        }
    });

    if (name == MANAGER_NAME) {
        process.exit();     // Let new instance take over
    } else {
        _set_status("Started: " + name, false);
    }
}

function _stop(name, user, cb) {
    if (name == MANAGER_NAME) {
        runner.prepare_exit(cb);
    } else {
        const running = (runner.get_status(name) == 'running');

        if (name != REPOS_NAME && running) {
            if (user) {
                runner.stop(name);
                _set_status("Stopped: " + name, false);
            } else {
                runner.terminate(name);
            }
        }

        if (cb) {
            cb();
        }
    }
}

function _exit_for_update() {
    process.exit(perform_update);
}

function _queue_action(name, action_props) {
    action_queue[name] = action_props;

    if (Object.keys(action_queue).length == 1) {
        _perform_action();
    }
}

function _remove_action(name) {
    delete action_queue[name];

    _perform_action();      // Anything pending?
}

function _perform_action() {
    const length = Object.keys(action_queue).length;

    if (length) {
        const name = Object.keys(action_queue)[0];

        switch (action_queue[name].action) {
            case ACTION_INSTALL:
                _install(action_queue[name].url, _register_installed_version);
                break;
            case ACTION_UPDATE:
                if (name == MANAGER_NAME) {
                    _update(name, _start);
                } else {
                    _update(name, _register_updated_version);
                }
                break;
            case ACTION_UNINSTALL:
                _uninstall(name, _unregister_version);
                break;
        }
    }
}

function _queue_updates(updates) {
    for (const name in updates) {
        if (name == MANAGER_NAME) {
            self_update_pending = true;     // Prevent extension restarts
        } else {
            _queue_action(name, { action: ACTION_UPDATE });
        }
    }

    if (self_update_pending) {
        // Perform manager actions last
        _queue_action(MANAGER_NAME, { action: ACTION_UPDATE });
    }
}

function _query_installs(cb, name) {
    let args = ' list -g';

    if (name) {
        args += ' ' + name;
    }
    args += ' --depth=0';

    let exec = require('child_process').exec;
    exec('npm' + args, (err, stdout, stderr) => {
        if (err) {
            _set_status("Extension query failed", true);
            console.error(stderr);
            throw err;
        } else {
            const lines = stdout.split('\n');
            extension_root = lines[0] + '/';

            if (!name) {
                installed = {};
            }

            for (let i = 1; i < lines.length; i++) {
                let name_version = lines[i].split(' ')[1];
                if (name_version) {
                    name_version = name_version.split('@');
                    installed[name_version[0]] = name_version[1];
                }
            }

            // Internal callback
            if (cb) {
                cb(installed);
            }
            // User callback
            if (installs_cb) {
                installs_cb(installed);
            }
        }
    });
}

function _query_updates(cb, name) {
    let args = ' outdated -g';

    if (name) {
        args += ' ' + name;
    }
    args += ' --depth=0';

    let exec = require('child_process').exec;
    exec('npm' + args, (err, stdout, stderr) => {
        /* In npm 4.x the 'outdated' command has an exit code of 1 in case of outdated packages
         * still the output is in stdout (stderr is empty), hence the check for stderr instead of err.
         * Although old behavior (exit code of 0) may be selectable in future npm releases:
         * https://github.com/npm/npm/pull/16703
         * for compatibility it seems best to keep the stderr check.
         */
        if (stderr) {
            _set_status("Updates query failed", true);
            console.error(stderr);
            throw err;
        } else {
            const lines = stdout.split('\n');
            let updates = {};

            for (let i = 1; i < lines.length && lines[i]; i++) {
                const fields = lines[i].split(/[ ]+/);    // Split by space(s)
                const update_name = fields[0];
                const update_wanted = fields[2];

                updates[update_name] = update_wanted;
                updates_list[update_name] = update_wanted;
            }

            // User callback
            if (updates_cb) {
                // Supply full update list
                updates_cb(updates_list);
            }
            // Internal callback
            if (cb) {
                cb(updates);
            }
        }
    });
}

function _set_status(message, is_error) {
    if (status_cb) {
        status_cb(message, is_error);
    }

    if (is_error) {
        console.error('Err:', message);
    } else {
        console.log('Inf:', message);
    }
}

exports = module.exports = ApiExtensionInstaller;
