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
const ACTION_START_AND_LOG = 5;
const ACTION_RESTART = 6;
const ACTION_RESTART_AND_LOG = 7;
const ACTION_STOP = 8;

const action_strings = [
    '',
    'Install',
    'Update',
    'Uninstall',
    'Start',
    'Start (with logging)',
    'Restart',
    'Restart (with logging)',
    'Stop'
];

const stdout_write = process.stdout.write;
const stderr_write = process.stderr.write;
const module_dir = 'node_modules/';
const backup_dir = 'backup/';
const repos_dir = 'repos/';
const log_dir = 'log/';
const perform_update = 66;
const perform_restart = 67;

const fs = require('fs');
var ApiExtensionRunner = require('node-api-extension-runner');

var write_stream;
var runner;
var extension_root;
var features = {};
var repos = [];
var index_cache = {};
var installed = {};
var updates_list = {};
var action_queue = {};
var logging_active = false;
var logs_list = {};
var self_update_pending = false;
var self_update;

var repository_cb;
var installs_cb;
var updates_cb;
var status_cb;

function ApiExtensionInstaller(callbacks, logging, self_control) {
    process.on('SIGTERM', _terminate);
    process.on('SIGINT', _terminate);

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

    self_update = self_control;

    if (_check_prerequisites()) {
        _query_installs((installed) => {
            const mkdirp = require('mkdirp');

            features = _read_JSON_file_sync(extension_root + 'features.json');

            // Create log directory
            mkdirp(extension_root + log_dir, (err, made) => {
                if (err) {
                    console.error(err);
                } else {
                    let logs_array = [];

                    if (!features || features.log_mode != 'off') {
                        // Logging feature active
                        if (logging) {
                            // Logging enabled
                            logs_array = _read_JSON_file_sync('logging.json');
                            if (logs_array === undefined) logs_array = [];

                            if (logs_array && logs_array.includes(MANAGER_NAME)) {
                                // Start logging of manager stdout
                                const fd = _get_log_descriptor(MANAGER_NAME);
                                write_stream = fs.createWriteStream('', {flags: 'a', fd: fd});

                                process.stdout.write = function() {
                                    stdout_write.apply(process.stdout, arguments);
                                    write_stream.write.apply(write_stream, arguments);
                                };
                                process.stderr.write = function() {
                                    stderr_write.apply(process.stderr, arguments);
                                    write_stream.write.apply(write_stream, arguments);
                                };
                            }
                        }

                        logging_active = logging;
                    }

                    _set_status("Roon Extension Manager started!", false);

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

                    runner = new ApiExtensionRunner(MANAGER_NAME, (running) => {
                        // Start previously running extensions
                        for (let i = 0; i < running.length; i++) {
                            _start(running[i], logs_array.includes(running[i]));
                        }
                    });

                    // User callback
                    if (installs_cb) {
                        installs_cb(installed);
                    }
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

ApiExtensionInstaller.prototype.update_all = function() {
    if (!features || features.auto_update != 'off') {
        _query_updates(_queue_updates);
    }
}

ApiExtensionInstaller.prototype.restart_manager = function() {
    _restart(MANAGER_NAME, logging_active ? logs_list[MANAGER_NAME] : undefined);
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

    if (state == 'installed' && name != REPOS_NAME) {
        state = runner.get_status(name);
    }

    return {
        state:   state,
        version: version,
        logging: (logs_list[name] !== undefined)
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
        actions.push(_create_action_pair(ACTION_INSTALL));
    } else {
        if (updates_list[name]) {
            actions.push(_create_action_pair(ACTION_UPDATE));
        }

        if (name == MANAGER_NAME) {
            actions.push(_create_action_pair(ACTION_RESTART));
            if (logging_active) {
                actions.push(_create_action_pair(ACTION_RESTART_AND_LOG));
            }
        } else if (repos[index_cache[name].split(':')[0]].display_name != SYSTEM_NAME) {
            actions.push(_create_action_pair(ACTION_UNINSTALL));

            if (state == 'running') {
                actions.push(_create_action_pair(ACTION_RESTART));
                if (logging_active) {
                    actions.push(_create_action_pair(ACTION_RESTART_AND_LOG));
                }
                actions.push(_create_action_pair(ACTION_STOP));
            } else {
                actions.push(_create_action_pair(ACTION_START));
                if (logging_active) {
                    actions.push(_create_action_pair(ACTION_START_AND_LOG));
                }
            }
        }
    }

    return actions;
}

ApiExtensionInstaller.prototype.get_features = function() {
    return features;
}

ApiExtensionInstaller.prototype.set_log_state = function(logging) {
    if ((!logging_active && logging) || (logging_active && !logging)) {
        // State changed
        _restart(MANAGER_NAME);
    }
}

ApiExtensionInstaller.prototype.perform_action = function(action, name) {
    switch (action) {
        case ACTION_INSTALL:
            const index_pair = index_cache[name].split(':');
            const url = repos[index_pair[0]].extensions[index_pair[1]].repository.url;

            _queue_action(name, { action: ACTION_INSTALL, url: url });
            break;
        case ACTION_UPDATE:
            _query_updates(_queue_updates, name);
            break;
        case ACTION_UNINSTALL:
            _queue_action(name, { action: ACTION_UNINSTALL });
            break;
        case ACTION_START:
            _start(name, false);
            break;
        case ACTION_START_AND_LOG:
            _start(name, true);
            break;
        case ACTION_RESTART:
            _restart(name, false);
            break;
        case ACTION_RESTART_AND_LOG:
            _restart(name, true);
            break;
        case ACTION_STOP:
            _stop(name, true);
            break;
    }
}

function _create_action_pair(action) {
    return {
        title: action_strings[action],
        value: action
    };
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
    let main_repo = extension_root + module_dir + REPOS_NAME + '/repository.json';
    let local_repos = extension_root + repos_dir;
    let values = [];

    repos.push(repos_system);
    _add_to_repository(main_repo);

    fs.readdir(local_repos, (err, files) => {
        if (!err) {
            for(let i = 0; i < files.length; i++) {
                _add_to_repository(local_repos + files[i]);
            };
        }

        if (repos.length) {
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
        } else {
            _set_status("Extension Repository not found", true);
        }

        // User callback
        if (repository_cb) {
            repository_cb(values);
        }
    });
}

function _add_to_repository(file) {
    if (file.includes('.json')) {
        const new_repo = _read_JSON_file_sync(file);

        if (new_repo) {
            for (let i = 0; i < new_repo.length; i++) {
                const category = new_repo[i].display_name;
                let j = 0;

                for (; j < repos.length; j++) {
                    if (repos[j].display_name == category) {
                        repos[j].extensions = repos[j].extensions.concat(new_repo[i].extensions);
                        break;
                    }
                }

                if (j === repos.length) {
                    repos.push(new_repo[i]);
                }
            }
        }
    }
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
                _start(name, false);
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

function _get_log_descriptor(name) {
    const log_file = extension_root + log_dir + name + '.log';
    let descriptor = logs_list[name];

    // Get file descriptor if it hasn't been defined
    if (descriptor == undefined) {
        descriptor = fs.openSync(log_file, 'a');
        logs_list[name] = descriptor;
    }

    return descriptor;
}

function _start(name, log) {
    const cwd = extension_root + module_dir + name;
    let inherit_mode = 'ignore';

    if (log === undefined) {
        log = (logging_active && logs_list[name] !== undefined);
    }

    if (log) {
        inherit_mode = _get_log_descriptor(name);
    }

    runner.start(name, cwd, '.', inherit_mode, (code, signal, user) => {
        if (user) {
            _set_status("Stopped: " + name, false);
        } else if (code !== null) {
            _set_status("Terminated: " + name + " (" + code +")", code);
        } else if (signal) {
            _set_status("Terminated: " + name + " (" + signal +")", false);
        }

        // Close log file
        if (logs_list[name]) {
            fs.closeSync(logs_list[name]);
            if (user) {
                delete logs_list[name];
            } else {
                logs_list[name] = null;
            }
        }
    });

    if (name == MANAGER_NAME) {
        _terminate(0, log);   // Let new instance take over
    } else if (log) {
        _set_status("Started (with logging): " + name, false);
    } else {
        _set_status("Started: " + name, false);
    }
}

function _restart(name, log) {
    _stop(name, false, () => {
        if (self_update || name != MANAGER_NAME) {
            _start(name, log);
        } else {
            _terminate(perform_restart, log);
        }
    });
}

function _stop(name, user, cb) {
    if (name != MANAGER_NAME && name != REPOS_NAME) {
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

function _terminate(exit_code, log) {
    if (logging_active) {
        // Close log files
        for (const name in logs_list) {
            if (name == MANAGER_NAME) {
                process.stdout.write = stdout_write;
                process.stderr.write = stderr_write;

                if (write_stream) {
                    write_stream.end();
                }
            }
        }

        if (log !== undefined) {
            // Logging specified
            if (log && !logs_list[MANAGER_NAME]) {
                // Switched on
                logs_list[MANAGER_NAME] = null;
            } else if (!log && logs_list[MANAGER_NAME]) {
                // Switched off
                delete logs_list[MANAGER_NAME];
            }
        }

        // Write names of logging extensions to file
        fs.writeFileSync('logging.json', JSON.stringify(Object.keys(logs_list)));
    }

    runner.prepare_exit(() => {
        if (exit_code) {
            process.exit(exit_code);
        } else {
            process.exit(0);
        }
    });
}

function _exit_for_update() {
    _terminate(perform_update);
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
    if (Object.keys(updates).length) {
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
    } else {
        console.log("No updates found");
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

function _read_JSON_file_sync(file) {
    let parsed = undefined;

    try {
        let data = fs.readFileSync(file, 'utf8');
        parsed = JSON.parse(data);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }

    return parsed;
}

exports = module.exports = ApiExtensionInstaller;
