// Copyright 2017, 2018, 2019, 2020, 2021 The Appgineer
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
const MANAGER_INDEX = 1;

const REPOS_NAME = 'roon-extension-repository';
const REPOS_GIT = "https://github.com/TheAppgineer/roon-extension-repository.git";
const REPOS_INDEX = 2;

const MIN_REPOS_VERSION = "0.3.0"

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
const binds_dir = 'binds/';
const perform_update = 66;
const perform_restart = 67;

const fs = require('fs');
var ApiExtensionRunner = require('node-api-extension-runner');
var ApiExtensionInstallerDocker = require('node-api-extension-installer-docker');

var write_stream;
var runner = undefined;
var docker = undefined;
var extension_root;
var features;
var repos = [];
var index_cache = {};
var npm_installed = {};
var npm_preferred = true;
var docker_installed = {};
var containerized;
var updates_list = {};
var action_queue = {};
var logging_active = false;
var logs_list = {};
var self_update_pending = false;
var session_error;

var repository_cb;
var status_cb;
var on_activity_changed;

function ApiExtensionInstaller(callbacks, logging, use_runner, features_file) {
    process.on('SIGTERM', _handle_signal);
    process.on('SIGINT', _handle_signal);
    process.on('SIGBREAK', _handle_signal);

    if (callbacks) {
        if (callbacks.repository_changed) {
            repository_cb = callbacks.repository_changed;
        }
        if (callbacks.status_changed) {
            status_cb = callbacks.status_changed;
        }
    }

    if (_check_prerequisites()) {
        _query_installs(() => {
            const mkdirp = require('mkdirp');

            if (features_file) {
                features = _read_JSON_file_sync(features_file);
            }

            if (!features && extension_root) {
                features = _read_JSON_file_sync(extension_root + 'features.json');
            }

            // Create log directory
            extension_root && mkdirp(extension_root + log_dir, (err, made) => {
                if (err) {
                    console.error(err);
                } else {
                    let logs_array = [];

                    _set_status("Starting Roon Extension Manager...", false);

                    if (!features || features.log_mode != 'off') {
                        // Logging feature active
                        if (logging) {
                            // Logging enabled
                            logs_array = _read_JSON_file_sync('logging.json');
                            if (logs_array === undefined) logs_array = [];

                            if (logs_array && logs_array.includes(MANAGER_NAME) &&
                                    (!features || features.log_mode != 'child_nodes')) {
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

                    // Create backup directory, used during update
                    mkdirp(extension_root + backup_dir, (err, made) => {
                        if (err) {
                            console.error(err);
                        }
                    });

                    docker = new ApiExtensionInstallerDocker((err, installed) => {
                        if (err) {
                            // Docker errors are not critical for operation
                            console.log('Warning: ' + err);

                            npm_preferred = true;
                        } else {
                            _set_status(`Docker for Linux found: Version ${docker.get_status().version}`, false);

                            npm_preferred = (!features || features.docker_install != 'prio');

                            if (!features || features.docker_install != 'off') {
                                docker_installed = installed;

                                for (let i = 0; i < logs_array.length; i++) {
                                    const name = logs_array[i];

                                    if (docker_installed[name] && docker.get_status(name).state == 'running') {
                                        console.log("Capturing log stream of " + name);
                                        docker.log(name, _get_log_descriptor(name));
                                    }
                                }
                            }
                        }

                        // Make sure post install actions have been performed
                        _post_install(MANAGER_NAME, undefined, () => {
                            if (!npm_installed[REPOS_NAME]) {
                                // Install extension repository
                                _queue_action(REPOS_NAME, { action: ACTION_INSTALL, url: REPOS_GIT });
                            } else if ( npm_installed[REPOS_NAME] < MIN_REPOS_VERSION) {
                                _queue_action(REPOS_NAME, { action: ACTION_UPDATE });
                            } else {
                                _load_repository();
                            }

                            if (use_runner) {
                                runner = new ApiExtensionRunner(MANAGER_NAME, (running) => {
                                    // Start previously running extensions
                                    for (let i = 0; i < running.length; i++) {
                                        if (npm_installed[running[i]]) {
                                            _start(running[i], logs_array.includes(running[i]));
                                        }
                                    }
                                });

                                callbacks.started && callbacks.started();
                            }
                        });
                    });
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
            const name = _get_name(extensions[i]);

            values.push({
                title: extensions[i].display_name,
                value: name
            });

            // Take the opportunity to cache the item
            index_cache[name] = [category_index, i];
        }
    }

    values.sort(_compare);

    return values;
}

ApiExtensionInstaller.prototype.update = function(name) {
    ApiExtensionInstaller.prototype.perform_action.call(this, ACTION_UPDATE, name);
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
    if (docker_installed[name]) {
        let status = docker.get_status(name);

        status.logging = (logs_list[name] !== undefined);

        return status;
    } else {
        // npm.get_status(name)
        const version = npm_installed[name];

        let state = (version ? 'installed' : 'not_installed');

        if (state == 'installed' && name != REPOS_NAME && runner) {
            state = runner.get_status(name);
        }

        return {
            state:   state,
            version: version,
            logging: (logs_list[name] !== undefined)
        };
    }
}

ApiExtensionInstaller.prototype.get_details = function(name) {
    const index_pair = _get_index_pair(name);
    const extension = repos[index_pair[0]].extensions[index_pair[1]];

    return {
        author:       extension.author,
        packager:     extension.packager,
        display_name: extension.display_name,
        description:  extension.description
    };
}

ApiExtensionInstaller.prototype.get_actions = function(name) {
    const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;
    let actions = [];
    let options;

    if (state == 'not_installed') {
        const index_pair = _get_index_pair(name);
        const extension = repos[index_pair[0]].extensions[index_pair[1]];

        actions.push(_create_action_pair(ACTION_INSTALL));

        if (!npm_preferred || !extension.repository) {
            options = docker.get_install_options(extension.image);
        }
    } else {
        if (updates_list[name]) {
            actions.push(_create_action_pair(ACTION_UPDATE));
        }

        if (name == MANAGER_NAME) {
            if (state == 'running') {
                actions.push(_create_action_pair(ACTION_RESTART));

                if (logging_active && (!features || features.log_mode != 'child_nodes')) {
                    actions.push(_create_action_pair(ACTION_RESTART_AND_LOG));
                }
            }
        } else if (repos[_get_index_pair(name)[0]].display_name != SYSTEM_NAME) {
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

    return {
        actions: actions,
        options: options
    };
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

ApiExtensionInstaller.prototype.perform_action = function(action, name, options) {
    switch (action) {
        case ACTION_INSTALL:
            _queue_action(name, { action: ACTION_INSTALL, options: options });
            break;
        case ACTION_UPDATE:
            if (updates_list[name]) {
                let update = {};

                update[name] = updates_list[name];
                _queue_updates(update);
            }
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

ApiExtensionInstaller.prototype.set_on_activity_changed = function(cb) {
    on_activity_changed = cb;
}

ApiExtensionInstaller.prototype.is_idle = function(name) {
    return (name ? !action_queue[name] : !Object.keys(action_queue).length);
}

ApiExtensionInstaller.prototype.get_logs_archive = function(cb) {
    const tar = require('tar');
    const backup_file = extension_root + backup_dir + 'extension-logs.tar.gz';
    const options = { file: backup_file, cwd: extension_root, gzip: true };

    tar.create(options, [log_dir], () => {
        cb && cb(backup_file);
    });
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
    const main_repo = extension_root + module_dir + REPOS_NAME + '/repository.json';
    const local_repos = extension_root + repos_dir;

    repos.length = 0;       // Cleanup first

    repos.push(repos_system);

    _add_to_repository(main_repo);

    fs.readdir(local_repos, (err, files) => {
        if (!err) {
            for(let i = 0; i < files.length; i++) {
                _add_to_repository(local_repos + files[i]);
            };
        }

        if (repos.length) {
            let values = [];

            // Collect extension categories
            for (let i = 0; i < repos.length; i++) {
                if (repos[i].display_name) {
                    values.push({
                        title: repos[i].display_name,
                        value: i
                    });
                }
            }

            npm_installed = _get_npm_installed_extensions(npm_installed);
            console.log(npm_installed);

            docker_installed = _get_docker_installed_extensions(docker_installed);
            console.log(docker_installed);

            _set_status("Extension Repository loaded", false);

            _query_updates(() => {
                repository_cb && repository_cb(values);
            });
        } else {
            _set_status("Extension Repository not found", true);

            repository_cb && repository_cb();
        }
    });
}

function _add_to_repository(file) {
    if (file.includes('.json')) {
        const new_repo = _read_JSON_file_sync(file);

        if (new_repo) {
            const npm_install_active    = (!features || features.npm_install != 'off');
            const docker_install_active = (docker.get_status().version ? true : false);

            for (let i = 0; i < new_repo.length; i++) {
                let filtered = {
                    display_name: new_repo[i].display_name,
                    extensions: []
                };
                let j;

                // Is the install type available and active?
                for (j = 0; j < new_repo[i].extensions.length; j++) {
                    if ((new_repo[i].extensions[j].repository && npm_install_active) ||
                            (new_repo[i].extensions[j].image && docker_install_active)) {
                        filtered.extensions.push(new_repo[i].extensions[j]);
                    }
                }

                // Does category already exist?
                for (j = 0; j < repos.length; j++) {
                    if (repos[j].display_name == filtered.display_name) {
                        break;
                    }
                }

                if (filtered.extensions.length) {
                    if (j === repos.length) {
                        // New category
                        repos.push(filtered);
                    } else {
                        // Add to existing category
                        repos[j].extensions = repos[j].extensions.concat(filtered.extensions);
                    }
                }
            }
        }
    }
}

function _get_npm_installed_extensions(installed) {
    let installed_extensions = {};

    if (installed) {
        for (const name in installed) {
            // Only packages that are included in the repository
            if (_get_index_pair(name)) {
                installed_extensions[name] = installed[name];
            }
        }
    }

    return installed_extensions;
}

function _get_docker_installed_extensions(installed) {
    let installed_extensions = {};

    if (installed) {
        for (const name in installed) {
            // Only images that are included in the repository
            if (_get_index_pair(name)) {
                if (name == MANAGER_NAME) {
                    // Looks like we're running in a container
                    containerized = true;
                } else {
                    installed_extensions[name] = installed[name];
                }
            }
        }
    }

    return installed_extensions;
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

function _get_name(extension) {
    let name;

    if (extension.repository) {
        // npm.get_name(extension.repository)
        let substrings = extension.repository.url.split(':');

        if (substrings && substrings[0] == 'https') {
            substrings = substrings[1].split('.');

            if (substrings[2].indexOf('git') === 0) {
                substrings = substrings[1].split('/');
                name = substrings[2];
            }
        }
    } else if (extension.image) {
        name = docker.get_name(extension.image);
    }

    return name;
}

function _get_index_pair(name) {
    let index_pair = index_cache[name];

    if (!index_pair) {
        for (let i = 0; i < repos.length; i++) {
            const extensions = repos[i].extensions;

            for (let j = 0; j < extensions.length; j++) {
                const entry_name = _get_name(extensions[j]);

                index_cache[entry_name] = [i, j];

                if (entry_name == name) {
                    index_pair = index_cache[entry_name];
                    break;
                }
            }
        }
    }

    return index_pair;
}

function _install(name, options, cb) {
    if (name) {
        let extension;

        if (name == REPOS_NAME) {
            // Repository not installed yet, access system repo directly
            extension = repos_system.extensions[REPOS_INDEX];
        } else {
            const index_pair = _get_index_pair(name);

            extension = repos[index_pair[0]].extensions[index_pair[1]];
        }

        _set_status("Installing: " + name + "...", false);

        if ((npm_preferred && extension.repository && extension.image) ||   // Both available, npm preferred
                (extension.repository && !extension.image)) {               // Only npm available
            // npm.install()
            const exec = require('child_process').exec;

            exec('npm install -g ' + extension.repository.url, (err, stdout, stderr) => {
                if (err) {
                    console.error(stderr);

                    cb && cb(name, err);
                } else {
                    _post_install(name, undefined, cb);
                }
            });
        } else if (extension.image) {                                       // Docker available
            const bind_props = {
                root:       extension_root,
                binds_path: binds_dir + name,
                name:       (containerized ? MANAGER_NAME : undefined)
            };

            docker.install(extension.image, bind_props, options, (err, tag) => {
                if (err) {
                    _set_status("Installation failed: " + name, true);
                    console.error(err);
                } else {
                    docker_installed[name] = tag;
                }

                cb && cb(name);
            });
        }
    }
}

function _register_installed_version(name, err) {
    _register_version(name, false, err);
}

function _register_updated_version(name, err) {
    _register_version(name, true, err);
}

function _register_version(name, update, err) {
    const version = npm_installed[name] || docker_installed[name];

    if (err) {
        _set_status((update ? 'Update' : 'Installation') + ' failed: ' + name, true);
    } else if (version) {
        _set_status((update ? 'Updated: ' : 'Installed: ') + name + ' (' + version + ')', false);

        if (name == REPOS_NAME) {
            if (!self_update_pending) {
                _load_repository();
            }
        } else {
            if (update) {
                const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;

                if ((!self_update_pending || docker_installed[name]) && state != 'stopped') {
                    _start(name);
                }
            } else {
                _start(name, false);
            }

            _query_updates(null, name);
        }
    }

    // Update administration
    _remove_action(name);
    session_error = undefined;
}

function _update(name, cb) {
    if (name) {
        if (runner && name == MANAGER_NAME) {
            _stop(name, false, _exit_for_update);
        } else {
            _stop(name, false, () => {
                _set_status("Updating: " + name + "...", false);

                if (npm_installed[name]) {
                    const cwd = extension_root + module_dir + name + '/';
                    const backup_file = extension_root + backup_dir + name + '.tar';
                    const options = { file: backup_file, cwd: cwd };

                    _backup(name, options, (clean) => {
                        const exec = require('child_process').exec;
                        exec('npm update -g ' + name, (err, stdout, stderr) => {
                            if (err) {
                                console.error(stderr);

                                cb && cb(name, err);
                            } else {
                                _post_install(name, (clean ? undefined : options), cb);
                            }
                        });
                    });
                } else if (docker_installed[name]) {
                    docker.update(name, (err) => {
                        if (err) {
                            console.error(err);
                        }

                        cb && cb(name);
                    });
                }
            });
        }
    }
}

function _post_install(name, options, cb) {
    _query_installs((peer_deps) => {
        if (peer_deps) {
            _install_peer_dependency(name, peer_deps, peer_deps.length - 1, () => {
                _read_npmignore(name, options, () => {
                    if (runner && name == MANAGER_NAME) {
                        _terminate(perform_restart, logging_active ? logs_list[MANAGER_NAME] : undefined);
                    } else {
                        cb && cb(name);
                    }
                });
            });
        } else {
            _read_npmignore(name, options, cb);
        }
    }, name);   // Query installed extension to obtain version number
}

function _read_npmignore(name, options, cb) {
    const npmignore = extension_root + module_dir + name + '/.npmignore';

    fs.readFile(npmignore, 'utf8', (err, data) => {
        if (err) {
            _download_gitignore(name, (data) => {
                if (data) {
                    fs.writeFileSync(npmignore, data);
                }

                _restore(name, options, cb);
            });
        } else {
            _restore(name, options, cb);
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

function _restore(name, options, cb) {
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
}

function _download_gitignore(name, cb) {
    const index_pair = _get_index_pair(name);
    let git;

    // Get git url from repository
    if (index_pair) {
        git = repos[index_pair[0]].extensions[index_pair[1]].repository.url;
    } else if (name == MANAGER_NAME) {
        git = repos_system.extensions[MANAGER_INDEX].repository.url;
    } else if (name == REPOS_NAME) {
        git = repos_system.extensions[REPOS_INDEX].repository.url;
    }

    if (git && git.includes('github')) {
        const https = require('https');
        const parts = git.split('#');
        let branch = 'master';

        if (parts.length > 1) {
            branch = parts[1];
        } else if (name == MANAGER_NAME) {
            // Get committish from package.json
            const package_json = _read_JSON_file_sync(extension_root + module_dir + name + '/package.json');

            if (package_json && package_json._requested && package_json._requested.gitCommittish) {
                branch = package_json._requested.gitCommittish;
            }
        }

        let url = parts[0].replace('.git', '/' + branch + '/.gitignore');
        url = url.replace('github', 'raw.githubusercontent');
        console.log('url:', url);

        https.get(url, (response) => {
            if (response.statusCode == 200) {
                let body = "";

                response.on('data', (data) => {
                    body += data;
                });
                response.on('end', () => {
                    cb && cb(body);
                });
            } else {
                if (response.statusCode == 404) {
                    console.log('.gitignore file not found');
                } else {
                    console.error(data.toString());
                }

                cb && cb();
            }
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

        if (line[line.length - 1] == '/') {
            // Remove trailing slash
            line = line.substring(0, line.length - 1);
        }

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

            if (npm_installed[name]) {
                // npm.uninstall
                const exec = require('child_process').exec;
                exec('npm uninstall -g ' + name, (err, stdout, stderr) => {
                    cb && cb(name);

                    console.log(npm_installed);
                });
            } else if (docker_installed[name]) {
                docker.uninstall(name, (err, installed) => {
                    if (err) {
                        _set_status("Uninstall failed: " + name, true);
                        console.error(err);
                    } else {
                        docker_installed = _get_docker_installed_extensions(installed);
                    }

                    cb && cb(name);
                });
            }
        });
    }
}

function _unregister_version(name) {
    if (npm_installed[name]) {
        delete npm_installed[name];
        delete updates_list[name];
    }

    _set_status("Uninstalled: " + name, false);
    _remove_action(name);
    session_error = undefined;
}

function _get_log_descriptor(name) {
    let descriptor = logs_list[name];

    // Get file descriptor if it hasn't been defined
    if (descriptor == undefined) {
        const log_file = extension_root + log_dir + name + '.log';

        descriptor = fs.openSync(log_file, 'a');
        logs_list[name] = descriptor;
    }

    return descriptor;
}

function _start(name, log) {
    let fd;

    if (log === undefined) {
        log = (logging_active && logs_list[name] !== undefined);
    } else if (log === false && logs_list[name] === null) {
        delete logs_list[name];     // Logging explicitly got deactivated
    }

    if (log) {
        fd = _get_log_descriptor(name);
    }

    if (npm_installed[name]) {
        // npm.start()
        const cwd = extension_root + module_dir + name;

        runner.start(name, cwd, '.', (fd ? fd : 'ignore'), (code, signal, user) => {
            if (user) {
                _set_status("Stopped: " + name, false);
            } else if (code !== null) {
                const WINDOWS_USER_BREAK = 3221225786;

                _set_status("Process terminated: " + name + " (" + code +")", code && code != WINDOWS_USER_BREAK);
            } else if (signal) {
                _set_status("Process terminated: " + name + " (" + signal +")", false);
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
    } else if (docker_installed[name]) {
        docker.start(name, fd);
    }

    if (log) {
        _set_status("Started (with logging): " + name, false);
    } else {
        _set_status("Started: " + name, false);
    }
}

function _restart(name, log) {
    _stop(name, false, () => {
        if (runner && name == MANAGER_NAME) {
            _terminate(perform_restart, log);
        } else {
            _start(name, log);
        }
    });
}

function _stop(name, user, cb) {
    _set_status("Terminating process: " + name + "...", false);

    if (npm_installed[name]) {
        // npm.stop()
        if (runner && runner.get_status(name) == 'running' && name != MANAGER_NAME) {
            if (user) {
                runner.stop(name, cb);
            } else {
                runner.terminate(name, cb);
            }
        } else if (cb) {
            cb();
        }
    } else if (docker_installed[name]) {
        if (user) {
            docker.stop(name, () => {
                _set_status("Stopped: " + name, false);

                cb && cb();
            });
        } else {
            docker.terminate(name, () => {
                _set_status("Process terminated: " + name, false);

                cb && cb();
            });
        }
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

    if (runner) {
        runner.prepare_exit(() => {
            if (exit_code) {
                process.exit(exit_code);
            } else {
                process.exit(0);
            }
        });
    } else {
        if (exit_code) {
            process.exit(exit_code);
        } else {
            process.exit(1);
        }
    }
}

function _exit_for_update() {
    _terminate(perform_update);
}

function _handle_signal(signal) {
    _terminate();
}

function _queue_action(name, action_props) {
    if (!action_queue[name]) {      // No action replace
        action_queue[name] = action_props;

        if (Object.keys(action_queue).length == 1) {
            on_activity_changed && on_activity_changed();
            _perform_action();
        }
    }
}

function _remove_action(name) {
    delete action_queue[name];

    _perform_action();      // Anything pending?
}

function _perform_action() {
    if (Object.keys(action_queue).length) {
        const name = Object.keys(action_queue)[0];

        if (!session_error) {
            // New session
            session_error = false;
        }

        switch (action_queue[name].action) {
            case ACTION_INSTALL:
                _install(name, action_queue[name].options, _register_installed_version);
                break;
            case ACTION_UPDATE:
                if (name == MANAGER_NAME) {
                    _update(name);
                } else {
                    _update(name, _register_updated_version);
                }
                break;
            case ACTION_UNINSTALL:
                _uninstall(name, _unregister_version);
                break;
            default:
                // Not a session
                session_error = undefined;
                break;
        }
    } else {
        on_activity_changed && on_activity_changed();
    }
}

function _queue_updates(updates) {
    if (updates && Object.keys(updates).length) {
        for (const name in updates) {
            if (name == MANAGER_NAME) {
                self_update_pending = true;     // Prevent extension restarts
            } else {
                _queue_action(name, { action: ACTION_UPDATE });
            }
        }

        if (self_update_pending) {
            // Perform manager actions last
            if (runner && updates_list[UPDATER_NAME]) {
                _queue_action(UPDATER_NAME, { action: ACTION_UPDATE });
            }
            _queue_action(MANAGER_NAME, { action: ACTION_UPDATE });
        }
    } else {
        console.log("No updates found");
    }
}

function _query_installs(cb, name) {
    let command = 'npm list -g --depth=0';

    if (name) {
        command += ' ' + name;
    }

    const exec = require('child_process').exec;
    exec(command, (err, stdout, stderr) => {
        const lines = stdout.split('\n');
        let peer_deps;
        let other_error = false;

        extension_root = lines[0] + '/';

        if (name && err) {
            const err_lines = stderr.split('\n');

            for (let i = 0; i < err_lines.length; i++) {
                const err_line = err_lines[i].split(': ');

                if (err_line[0] == 'npm ERR! peer dep missing' || err_line[0] == 'npm ERR! missing') {
                    if (!peer_deps) peer_deps = {};

                    peer_deps[err_line[1].split(', ')[0]] = undefined;
                } else if (err_lines[i]) {
                    console.error(err_lines[i]);
                    other_error = true;
                }
            }
        }

        if (other_error) {
            _set_status("Extension query failed", true);

            cb && cb();
        } else {
            // Process global list output (npm list -g)
            if (name) {
                delete npm_installed[name];
            } else {
                npm_installed = {};
            }

            for (let i = 1; i < lines.length; i++) {
                let name_version = lines[i].split(' ')[1];
                if (name_version) {
                    name_version = name_version.split('@');
                    npm_installed[name_version[0]] = name_version[1];
                }
            }

            if (repos.length) {
                // Only packages that are included in the repository
                npm_installed = _get_npm_installed_extensions(npm_installed);
            }

            cb && cb(peer_deps ? Object.keys(peer_deps) : undefined);
        }
    });
}

function _install_peer_dependency(name, peer_deps, count, cb) {
    const exec = require('child_process').exec;
    const cwd = extension_root + module_dir + name;
    const package_string = peer_deps[count];

    _set_status("Installing peer dependency: " + package_string + "...", false);

    exec('npm install ' + package_string, { cwd: cwd }, (err, stdout, stderr) => {
        if (err) {
            console.error(stderr);
            _set_status("Installation failed: " + package_string, true);

            if (name != MANAGER_NAME) {
                // Installation of peer dependency failed: uninstall full package
                _remove_action(name);
                _queue_action(name, { action: ACTION_UNINSTALL });
            }
        } else if (count) {
            _install_peer_dependency(name, peer_deps, count - 1, cb);
        } else {
            cb && cb(name);
        }
    });
}

function _query_updates(cb, name) {
    let results = {};

    if (Object.keys(docker_installed).length) {
        docker.query_updates((updates) => {
            for (const name in updates) {
                // Only images that are included in the repository
                if (name != MANAGER_NAME && _get_index_pair(name)) {
                    results[name] = updates[name];
                    updates_list[name] = updates[name];
                }
            }
        }, name);
    }

    // npm.query_updates()
    const exec = require('child_process').exec;
    let command = 'npm outdated -g --depth=0';

    if (name) {
        command += ' ' + name;
    }

    exec(command, (err, stdout, stderr) => {
        /* In npm 4.x the 'outdated' command has an exit code of 1 in case of outdated packages
         * still the output is in stdout (stderr is empty), hence the check for stderr instead of err.
         * Although old behavior (exit code of 0) may be selectable in future npm releases:
         * https://github.com/npm/npm/pull/16703
         * for compatibility it seems best to keep the stderr check.
         */
        if (stderr) {
            _set_status("Updates query failed", true);
            console.error(stderr);
        } else if (stdout) {
            const lines = stdout.split('\n');

            for (let i = 1; i < lines.length && lines[i]; i++) {
                const fields = lines[i].split(/[ ]+/);    // Split by space(s)
                const update_name = fields[0];
                const update_wanted = fields[2];

                // Only packages that are included in the repository
                if (_get_index_pair(update_name)) {
                    results[update_name] = update_wanted;
                    updates_list[update_name] = update_wanted;
                }
            }
        } else {
            /* In npm 7.x (at least 7.3.0) the 'outdated' command gives no output on git dependencies,
            * this might be a bug as documentation still says that these are always reinstalled.
            * The workaround is to take over the installed npm based extensions as these are all git dependencies.
            */
            if (name) {
                results[name] = npm_installed[name];
                updates_list[name] = npm_installed[name];
            } else {
                for (const name in npm_installed) {
                    results[name] = npm_installed[name];
                    updates_list[name] = npm_installed[name];
                }
            }
        }

        if (cb) {
            cb(results);
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

    if (!session_error && status_cb) {
        status_cb(message, is_error);
    }

    if (session_error === false && is_error) {
        session_error = true;
    }
}

function _read_JSON_file_sync(file) {
    let parsed = undefined;

    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.toString().includes('SyntaxError')) {
            console.error(err);
        } else if (err.code !== 'ENOENT') {
            throw err;
        }
    }

    return parsed;
}

exports = module.exports = ApiExtensionInstaller;
