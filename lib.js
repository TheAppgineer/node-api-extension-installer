// Copyright 2017, 2018 The Appgineer
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

// System repository entries
const SYSTEM_NAME = "System";

const UPDATER_NAME = "roon-extension-manager-updater";
const MANAGER_NAME = "roon-extension-manager";
const REPOS_NAME = 'roon-extension-repository';

const REPOS_GIT = "https://github.com/TheAppgineer/roon-extension-repository.git";

const MIN_REPOS_VERSION = "0.2.0"

const repos_system = {
    display_name: SYSTEM_NAME,
    extensions: [{
        repository: {
            type: "git",
            url: "https://github.com/TheAppgineer/roon-extension-manager-updater.git"
        }
    },
    {
        author: "The Appgineer",
        display_name: "Extension Manager",
        description: "Roon Extension for managing Roon Extensions",
        repository: {
            type: "git",
            url: "https://github.com/TheAppgineer/roon-extension-manager.git"
        }
    },
    {
        author: "The Appgineer",
        display_name: "Extension Repository",
        description: "Repository of (community developed) Roon Extensions",
        repository: {
            type: "git",
            url: REPOS_GIT
        }
    }]
};

const ACTION_INSTALL = 1;
const ACTION_UPDATE = 2;
const ACTION_UNINSTALL = 3;
const ACTION_START = 4;
const ACTION_RESTART = 5;
const ACTION_STOP = 6;

const module_dir = 'node_modules/'
const backup_dir = 'backup/'
const perform_update = 66;
const perform_restart = 67;

var ApiExtensionRunner = require('node-api-extension-runner');

var runner;
var extension_root;
var repos = [];
var index_cache = {};
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
                    console.error(err);
                }
            });

            if (!installed[REPOS_NAME]) {
                // Install extension repository
                _queue_action(REPOS_NAME, { action: ACTION_INSTALL, url: REPOS_GIT });
            } else if ( installed[REPOS_NAME] < MIN_REPOS_VERSION) {
                _queue_action(REPOS_NAME, { action: ACTION_UPDATE });
            } else {
                _load_repository();
            }

            runner = new ApiExtensionRunner((running) => {
                // Start previously running extensions
                for (let i = 0; i < running.length; i++) {
                    _start(running[i]);
                }
            });
        });
    }
}

ApiExtensionInstaller.prototype.get_extensions_by_category = function(category_index) {
    const extensions = repos[category_index].extensions;
    let values = [];

    // Collect extensions
    for (let i = 0; i < extensions.length; i++) {
        if (extensions[i].display_name) {
            const name = _get_name_from_url(extensions[i].repository.url);

            values.push({
                title: extensions[i].display_name,
                value: name
            });

            index_cache[name] = '' + category_index + ':' + i;
        }
    }

    values.sort(_compare);

    return values;
}

ApiExtensionInstaller.prototype.install = function(name) {
    const index_pair = index_cache[name].split(':');
    const url = repos[index_pair[0]].extensions[index_pair[1]].repository.url;

    _queue_action(name, { action: ACTION_INSTALL, url: url });
}

ApiExtensionInstaller.prototype.uninstall = function(name) {
    _queue_action(name, { action: ACTION_UNINSTALL });
}

ApiExtensionInstaller.prototype.update = function(name) {
    _query_updates(_queue_updates, name);
}

ApiExtensionInstaller.prototype.update_all = function() {
    _query_updates(_queue_updates);
}

ApiExtensionInstaller.prototype.start = function(name) {
    _start(name);
}

ApiExtensionInstaller.prototype.restart = function(name) {
    if (name == MANAGER_NAME) {
        ApiExtensionInstaller.prototype.restart_manager.call(this);
    } else {
        runner.restart(name, () => {
            _set_status("Restarted: " + name, false);
        });
    }
}

ApiExtensionInstaller.prototype.stop = function(name) {
    _stop(name, true);
}

ApiExtensionInstaller.prototype.restart_manager = function() {
    _stop(MANAGER_NAME, false, () => {
        if (self_update) {
            _start(MANAGER_NAME);
        } else {
            process.exit(perform_restart);
        }
    });
}

/**
 * Returns the status of an extension identified by name
 *
 * @param {String} name - The name of the extension according to its package.json file
 * @returns {('not_installed'|'installed'|'stopped'|'terminated'|'running')} - The status of the extension
 */
ApiExtensionInstaller.prototype.get_status = function(name) {
    const version = installed[name];
    let state = (version ? 'installed' : 'not_installed');

    if (state == 'installed' && repos[index_cache[name].split(':')[0]].display_name != SYSTEM_NAME) {
        state = runner.get_status(name);
    }

    return {
        state: state,
        version: version
    };
}

ApiExtensionInstaller.prototype.get_details = function(name) {
    const index_pair = index_cache[name].split(':');

    return repos[index_pair[0]].extensions[index_pair[1]];
}

ApiExtensionInstaller.prototype.get_actions = function(name) {
    const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;
    let actions = [];

    if (state == 'not_installed') {
        actions.push(ACTION_INSTALL);
    } else {
        if (updates_list[name]) {
            actions.push(ACTION_UPDATE);
        }

        if (repos[index_cache[name].split(':')[0]].display_name != SYSTEM_NAME) {
            actions.push(ACTION_UNINSTALL);

            if (state == 'running') {
                actions.push(ACTION_RESTART);
                actions.push(ACTION_STOP);
            } else {
                actions.push(ACTION_START);
            }
        } else if (name == MANAGER_NAME) {
            actions.push(ACTION_RESTART);
        }
    }

    return actions;
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

            repos.push(repos_system);
            repos = repos.concat(JSON.parse(data));

            // Collect extension categories
            for (let i = 0; i < repos.length; i++) {
                if (repos[i].display_name) {
                    values.push({
                        title: repos[i].display_name,
                        value: i
                    });
                }
            }

            _set_status("Extension Repository loaded", false);

            if (installed[MANAGER_NAME]) {
                _post_install(MANAGER_NAME);
            }

            _query_updates();

            // User callback
            if (repository_cb) {
                repository_cb(values);
            }
        }
    });
}

function _compare(a, b) {
    if (a.title.toLowerCase() < b.title.toLowerCase()) {
        return -1;
    }
    if (a.title.toLowerCase() > b.title.toLowerCase()) {
        return 1;
    }
    return 0;
}

function _get_name_from_url(url) {
    let substrings = url && url.split(':');

    if (substrings && substrings[0] == 'https') {
        substrings = substrings[1].split('.')
        if (substrings[2].indexOf('git') === 0) {
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
            } else {
                _post_install(name, undefined, cb);
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
        } else {
            if (update) {
                if (!self_update_pending && runner.get_status(name) != 'stopped') {
                    _start(name);
                }
            } else {
                _start(name);
            }

            _query_updates(null, name);
        }

        _remove_action(name);
    }, name);   // Query installed extension to obtain version number
}

function _update(name, cb) {
    if (name) {
        if (self_update || name != MANAGER_NAME) {
            _stop(name, false, () => {
                const cwd = extension_root + module_dir + name + '/';
                const backup_file = extension_root + backup_dir + name + '.tar';
                const options = { file: backup_file, cwd: cwd };

                _backup(name, options, (clean) => {
                    _set_status("Updating: " + name + "...", false);

                    let exec = require('child_process').exec;
                    exec('npm update -g ' + name, (err, stdout, stderr) => {
                        if (err) {
                            _set_status("Update failed: " + name, true);
                            console.error(stderr);
                        } else {
                            _post_install(name, (clean ? undefined : options), cb);
                        }
                    });
                });
            });
        } else {
            _stop(name, false, _exit_for_update);
        }
    }
}

function _post_install(name, options, cb) {
    const fs = require('fs');
    const npmignore = extension_root + module_dir + name + '/' + '.npmignore';

    fs.readFile(npmignore, 'utf8', (err, data) => {
        if (err) {
            _download_gitignore(name, (data) => {
                fs.writeFile(npmignore, data, (err) => {
                    if (err) {
                        console.error(err);
                    }
                });
            });
        }

        if (options) {
            const tar = require('tar');
            tar.extract(options, [], () => {
                if (cb) {
                    cb(name);
                }
            });
        } else if (cb) {
            cb(name);
        }
    });
}

function _backup(name, options, cb) {
    const fs = require('fs');

    fs.readFile(options.cwd + '.npmignore', 'utf8', (err, data) => {
        if (err) {
            // Working directory clean
            cb && cb(true);
        } else {
            _create_archive(data, options, cb);
        }
    });
}

function _download_gitignore(name, cb) {
    let git;

    // Get git url from repository
    if (index_cache[name]) {
        const index_pair = index_cache[name].split(':');

        git = repos[index_pair[0]].extensions[index_pair[1]].repository.url;
    } else {
        for (let i = 0; i < repos.length && !git; i++) {
            const extensions = repos[i].extensions;

            for (let j = 0; j < extensions.length; j++) {
                const entry_name = _get_name_from_url(extensions[j].repository.url);

                index_cache[entry_name] = '' + i + ':' + j;

                if (entry_name == name) {
                    git = extensions[j].repository.url;
                    break;
                }
            }
        }
    }

    if (git && git.includes('github')) {
        const https = require('https');
        const parts = git.split('#');
        const branch = (parts.length > 1 ? parts[1] : 'master');

        let url = parts[0].replace('.git', '/' + branch + '/.gitignore');
        url = url.replace('github', 'raw.githubusercontent');
        console.log('url:', url);

        https.get(url, (response) => {
            response.on('data', (data) => {
                if (response.statusCode == 200) {
                    cb && cb(data);
                } else {
                    console.error(data.toString());
                }
            });
        }).on('error', (err) => {
            console.error(err);
        });
    }
}

function _create_archive(data, options, cb) {
    const fs = require('fs');
    const tar = require('tar');
    const lines = data.split('\n');
    let globs = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();

        if (line && line != 'node_modules' && line[0] != '#') {
            if (fs.existsSync(options.cwd + line)) {
                globs.push(line);
            }
        }
    }

    if (globs.length) {
        tar.create(options, globs, cb);
    } else if (cb) {
        cb(true);
    }
}

function _uninstall(name, cb) {
    if (name) {
        _stop(name, true, () => {
            _set_status("Uninstalling: " + name + "...", false);

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

    runner.start(name, cwd, '.', inherit_mode, (code, signal, user) => {
        if (user) {
            _set_status("Stopped: " + name, false);
        } else if (code !== null) {
            _set_status("Terminated: " + name + " (" + code +")", code);
        } else if (signal) {
            _set_status("Terminated: " + name + " (" + signal +")", false);
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
        if (runner) {
            runner.prepare_exit(cb);
        } else if (cb) {
            cb();
        }
    } else if (name != REPOS_NAME) {
        _set_status("Terminating: " + name + "...", false);

        if (user) {
            runner.stop(name, cb);
        } else {
            runner.terminate(name, cb);
        }
    } else if (cb) {
        cb();
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
                    // TODO: Add support for update only case
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
        if (updates_list[UPDATER_NAME]) {
            _queue_action(UPDATER_NAME, { action: ACTION_UPDATE });
        }
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
        } else {
            const lines = stdout.split('\n');
            let results = {};
            let changes = {};

            for (let i = 1; i < lines.length && lines[i]; i++) {
                const fields = lines[i].split(/[ ]+/);    // Split by space(s)
                const update_name = fields[0];
                const update_wanted = fields[2];

                results[update_name] = update_wanted;

                if (updates_list[update_name] != update_wanted) {
                    updates_list[update_name] = update_wanted;
                    changes[update_name] = update_wanted;
                }
            }

            // User callback
            if (updates_cb && Object.keys(changes).length) {
                // Supply change list
                updates_cb(changes);
            }
            // Internal callback
            if (cb) {
                cb(results);
            }
        }
    });
}

function _set_status(message, is_error) {
    const date = new Date();

    if (is_error) {
        console.error(date.toISOString(), '- Err:', message);
    } else {
        console.log(date.toISOString(), '- Inf:', message);
    }

    if (status_cb) {
        status_cb(message, is_error);
    }
}

exports = module.exports = ApiExtensionInstaller;
