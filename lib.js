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
const MANAGER_INDEX = 0;

const REPOS_GIT = "https://github.com/TheAppgineer/roon-extension-repository.git";
const REPOS_NAME = 'roon-extension-repository';
const REPOS_INDEX = 1;

// Start index of community extensions
const COMMUNITY_INDEX = 2;

var ApiExtensionRunner = require('node-api-extension-runner');
var runner = new ApiExtensionRunner();

var extension_root;
var installed = {};
var update_list = {};
var installer_cb;
var status_cb;

var repos = [{
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

function ApiExtensionInstaller(on_installed_cb, on_status_changed_cb) {
    installer_cb = on_installed_cb;
    status_cb = on_status_changed_cb;

    if (_check_prerequisites()) {
        _query_installs((installed) => {
            if (!installed[REPOS_NAME]) {
                // Install extension repository
                _install(REPOS_INDEX, _load_repository);
            } else {
                _load_repository();
            }

            if (installer_cb) {
                installer_cb(installed);
            }
        });

        _query_updates();
    }
}

ApiExtensionInstaller.prototype.get_extension_list = function() {
    let values = [];

    // Collect extension names
    for (let i = COMMUNITY_INDEX; i < repos.length; i++) {
        values.push({
            title: repos[i].display_name,
            value: i
        });
    }

    return values;
}

ApiExtensionInstaller.prototype.install = function(repos_index) {
    _install(repos_index, _register_installed_version);
}

ApiExtensionInstaller.prototype.uninstall = function(repos_index) {
    const name = _get_name(repos_index);

    if (name) {
        _set_status("Uninstalling: " + name + "...", false);

        if (runner.get_status(name) == 'running') {
            runner.stop(name);
        }

        let exec_file = require('child_process').execFile;
        exec_file('npm', ['uninstall', '-g', name], (err, stdout, stderr) => {
            delete installed[name];
            delete update_list[name];
            _set_status("Uninstalled: " + name, false);

            if (installer_cb) {
                installer_cb(installed);
            }
        });
    }
}

ApiExtensionInstaller.prototype.update = function(repos_index) {
    _query_updates(_update_first, _get_name(repos_index));
}

ApiExtensionInstaller.prototype.update_all = function() {
    _query_updates(_update_first);
}

ApiExtensionInstaller.prototype.has_update = function(repos_index) {
    return update_list[_get_name(repos_index)];
}

ApiExtensionInstaller.prototype.start = function(repos_index) {
    let name = _get_name(repos_index);

    runner.start(name, extension_root);
    _set_status("Started: " + name, false);
}

ApiExtensionInstaller.prototype.stop = function(repos_index) {
    let name = _get_name(repos_index);

    runner.stop(name);
    _set_status("Stopped: " + name, false);
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
    let fs = require('fs');
    let repos_path = extension_root + REPOS_NAME + '/repository.json'

    fs.readFile(repos_path, 'utf8', function(err, data) {
        if (err) {
            _set_status("Extension Repository not found", true);
        } else {
            repos = repos.concat(JSON.parse(data));

            _set_status("Extension Repository loaded", false);
        }
    });
}

function _get_name(repos_index) {
    let substrings = repos[repos_index].repository.url.split(':');

    if ((substrings[0]) == 'https') {
        substrings = substrings[1].split('.')
        if ((substrings[2]) == 'git') {
            substrings = substrings[1].split('/')
            return substrings[2];
        }
    }

    return null;
}

function _install(repos_index, cb) {
    const git = repos[repos_index].repository.url;
    const name = _get_name(repos_index);

    if (name) {
        _set_status("Installing: " + name + "...", false);

        let exec_file = require('child_process').execFile;
        exec_file('npm', ['install', '-g', git], (err, stdout, stderr) => {
            if (err) {
                _set_status("Installation failed: " + name, true);
                console.log(stderr);
            } else if (cb) {
                cb(name);
            }
        });
    }
}

function _register_installed_version(name) {
    _query_installs((installed) => {
        let version = installed[name];
        _set_status("Installed: " + name + " (" + version + ")", false);

        if (installer_cb) {
            installer_cb(installed);
        }
        if (name != REPOS_NAME) {
            runner.start(name, extension_root);
        }
    }, name);   // Query installed extension to obtain version number

    _query_updates();
}

function _update(name, cb) {
    if (name) {
        _set_status("Updating: " + name + "...", false);

        if (name != REPOS_NAME) {
            runner.stop(name);
        }

        let exec_file = require('child_process').execFile;
        exec_file('npm', ['update', '-g', name], (err, stdout, stderr) => {
            if (err) {
                _set_status("Update failed: " + name, true);
                console.log(stderr);
            } else if (cb) {
                cb(name);
            }
        });
    }
}

function _update_first(updates) {
    if (update_list) {
        let name = Object.keys(update_list)[0];

        _update(name, _update_next);
        delete update_list[name];
    }
}

function _update_next(name) {
    _register_installed_version(name);

    if (update_list) {
        let name = Object.keys(update_list)[0];

        _update(name, _update_next);
        delete update_list[name];
    }
}

function _query_installs(cb, name = '') {
    let args = ['list', '-g'];

    if (name) {
        args.push(name);
    }
    args.push('--depth=0');

    let exec_file = require('child_process').execFile;
    exec_file('npm', args, (err, stdout, stderr) => {
        if (err) {
            _set_status("Extension query failed", true);
            console.log(stderr);
        } else {
            let lines = stdout.split('\n');
            extension_root = lines[0] + '/node_modules/';

            if (name == '') {
                installed = {};
            }

            for (let i = 1; i < lines.length; i++) {
                let name_version = lines[i].split(' ')[1];
                if (name_version) {
                    name_version = name_version.split('@');
                    installed[name_version[0]] = name_version[1];
                }
            }

            if (cb) {
                cb(installed);
            }
        }
    });
}

function _query_updates(cb, name = '') {
    let args = ['outdated', '-g'];

    if (name) {
        args.push(name);
    }
    args.push('--depth=0');

    let exec_file = require('child_process').execFile;
    exec_file('npm', args, (err, stdout, stderr) => {
        /* In npm 4.x the 'outdated' command has an exit code of 1 in case of outdated packages
         * still the output is in stdout (stderr is empty), hence the check for stderr instead of err.
         * Although old behavior (exit code of 0) may be selectable in future npm releases:
         * https://github.com/npm/npm/pull/16703
         * for compatibility it seems best to keep the stderr check.
         */
        if (stderr) {
            _set_status("Updates query failed", true);
            console.log(stderr);
        } else {
            let lines = stdout.split('\n');
            let updates = {};

            for (let i = 1; i < lines.length && lines[i]; i++) {
                let fields = lines[i].split(/[ ]+/);    // Split by space(s)
                updates[fields[0]] = fields[2];         // [name] = wanted
            }

            update_list = updates;

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

    console.log(is_error ? 'Err:' : 'Inf:', message);
}

exports = module.exports = ApiExtensionInstaller;
