/**
 * Nanocloud turns any traditional software into a cloud solution, without
 * changing or redeveloping existing source code.
 *
 * Copyright (C) 2016 Nanocloud Software
 *
 * This file is part of Nanocloud.
 *
 * Nanocloud is free software; you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * Nanocloud is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

/* global ConfigService, Machine, Image, User, BrokerLog */

const _ = require('lodash');
const Promise = require('bluebird');
const ManualDriver = require('../drivers/manual/driver');
const AWSDriver = require('../drivers/aws/driver');
const DummyDriver = require('../drivers/dummy/driver');
const QemuDriver = require('../drivers/qemu/driver');
const OpenstackDriver = require('../drivers/openstack/driver');
const promisePoller = require('promise-poller').default;

/**
 * Service responssible of the machine pool
 *
 * @class MachineService
 */

const driverNotInitializedError = new Error('Driver not initialized');
const driverAlreadyInitializedError = new Error('Driver already initialized');

const drivers = {
  manual    : ManualDriver,
  aws       : AWSDriver,
  dummy     : DummyDriver,
  qemu      : QemuDriver,
  openstack : OpenstackDriver
};

/**
 * The underlying driver used by the service.
 *
 * @property _driver
 * @type {Object}
 * @private
 */
let _driver = null;

/**
 * The promise returned by `initialize`. Used to prevent multiple
 * initializtions.
 *
 * @property initializing
 * @type {Promise}
 * @private
 */
let _initializing = null;

/**
 * Returns a Promise that reject `err` if `condition` if false. A resolved
 * Promise otherwise.
 *
 * @method assert
 * @private
 * @param {Boolean} condition The rejection condition
 * @param {Object} err The rejected error if condition is false
 * @return {Promise[Object]}
 */
function assert(condition, err) {
  if (condition) {
    return Promise.resolve();
  } else {
    return Promise.reject(err);
  }
}

/**
 * Initialize the Iaas driver. It uses the `ConfigService` variables:
 *  - iaas: the name of the iaas driver to use
 *
 * @method initialize
 * @return {Promise}
 */
function initialize() {
  return assert(_driver === null, driverAlreadyInitializedError)
    .then(() => {
      if (_initializing) {
        return _initializing;
      }

      _initializing = ConfigService.get('iaas')
        .then((config) => {
          return Image.findOrCreate({
            default: true
          }, {
            iaasId: null,
            name: 'Default',
            buildFrom: null,
            default: true
          })
            .then(() => {
              _driver = new (drivers[config.iaas])();

              return _driver.initialize()
                .then(() => {
                  updateMachinesPool();
                  return null;
                });
            });
        });

      return _initializing;
    });
}

/**
 * Retreive a machine for the specified user. If the user already has a machine,
 * then this machine is returned. Otherwise, if a machine is available, it is
 * affected to the user. Fails if there is no available machine.
 *
 * @method getMachineForUser
 * @param {User} The user associated to the machine
 * @return {Promise[Machine]} The user's machine
 */
function getMachineForUser(user) {
  return assert(!!_driver, driverNotInitializedError)
    .then(() => {
      return ConfigService.get('creditLimit');
    })
    .then((config) => {
      if (config.creditLimit !== '' && parseFloat(user.credit) >= parseFloat(config.creditLimit)) {
        return new Promise.reject('Exceeded credit');
      }
    })
    .then(() => {
      return Machine.findOne({
        where: {
          user: user.id
        }
      })
        .then((res) => {
          if (!res) {
            return new Promise((resolve, reject) => {
              Machine.query({
                text: `UPDATE machine m
            SET "user" = $1::varchar
            FROM (
              SELECT machine.id
              FROM machine
              WHERE "user" IS NULL AND "status" = 'running'
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            ) sub
            WHERE m.id = sub.id
            RETURNING *`,
                values: [user.id]
              }, (err, res) => {
                if (err) {
                  return reject(err);
                }

                if (res.rows.length) {
                  updateMachinesPool();
                  _createBrokerLog(res.rows[0], 'Assigned')
                    .then(() => {
                      return resolve(Machine.findOne({
                        id: res.rows[0].id
                      }));
                    });
                } else {

                  return reject('A machine is booting for you. Please retry in one minute.');
                }
              });
            });
          } else {
            return ConfigService.get('neverTerminateMachine')
              .then((config) => {
                if (config.neverTerminateMachine) {
                  if (res.status === 'stopped') {
                    startMachine(res);
                    return Promise.reject('Your machine is starting. Please retry in one minute.');
                  } else if (res.status === 'running') {
                    return Promise.resolve(res);
                  } else {
                    return Promise.reject(`Your machine is ${res.status}. Please retry in one minute.`);
                  }
                } else {
                  return Promise.resolve(res);
                }
              });
          }
        });
    });
}

/**
 * Return the name of the underlying iaas driver.
 *
 * @method driverName
 * @return {String}
 */
function driverName() {
  return _driver.name();
}

/**
 * Set the user's machine endDate to now + `ConfigService:sessionDuration`
 *
 * @method increaseUsersMachineEndDate
 * @param {User} user The user to which the machine belongs
 * @return {Promise}
 */
function increaseUsersMachineEndDate(user) {
  return ConfigService.get('sessionDuration')
    .then((config) => {
      return Machine.findOne({
        user: user.id
      })
        .then((machine) => {
          return machine.setEndDate(config.sessionDuration)
            .then(() => {
              setTimeout(() => {
                _shouldTerminateMachine(machine);
              }, config.sessionDuration * 1000);
            });
        });
    });
}

/**
 * Ask the underlying driver to create a new machine. It uses the
 * `ConfigService` variable:
 *  - machinesName: the name of the machine to be created
 *
 * @method _createMachine
 * @private
 * @return {Promise}
 */
function _createMachine() {

  return ConfigService.get('machinesName')
    .then((config) => {
      return _driver.createMachine({
        name: config.machinesName
      });
    })
    .then((machine) => {

      machine.status = 'booting';
      _createBrokerLog(machine, 'Created');
      return Machine.create(machine);
    })
    .then((machine) => {

      return promisePoller({
        taskFn: () => {
          return machine.refresh()
            .then((machine) => {

              if (machine.status === 'running') {
                return Promise.resolve(machine);
              } else {
                return Promise.reject(machine);
              }
            });
        },
        interval: 5000,
        retries: 100
      })
        .catch((errs) => { // If timeout is reached

          let machine = errs.pop(); // On timeout, promisePoller rejects with an array of all rejected promises. In our case, MachineService rejects the still booting machine. Let's pick the last one.

          _createBrokerLog(machine, 'Error');
          _terminateMachine(machine);
          throw machine;
        });
    })
    .then((machine) => {
      return machine.getPassword()
        .then((password) => {
          machine.password = password;

          return Machine.update({id: machine.id}, machine);
        })
        .then(() => {
          _createBrokerLog(machine, 'Available');
        });
    });
}

/**
 * Ask the driver to start the specified machine
 *
 * @method startMachine
 * @public
 * @return {Promise[Machine]}
 */
function startMachine(machine) {

  if (_driver.startMachine) {
    return _driver.startMachine(machine)
      .then((machineStarting) => {
        machineStarting.status = 'starting';

        return Machine.update({
          id: machineStarting.id
        }, machineStarting);
      })
      .then((machines) => {
        return promisePoller({
          taskFn: () => {
            return machines[0].refresh()
              .then((machineRefreshed) => {
                if (machineRefreshed.status === 'running') {
                  return Promise.resolve(machineRefreshed);
                } else {
                  return Promise.reject(machineRefreshed);
                }
              });
          },
          interval: 5000,
          retries: 100
        })
          .catch((errs) => { // If timeout is reached

            let machine = errs.pop(); // On timeout, promisePoller rejects with an array of all rejected promises. In our case, MachineService rejects the still booting machine. Let's pick the last one.

            _createBrokerLog(machine, 'Error waiting to start machine');
            _terminateMachine(machine);
            throw machine;
          });
      })
      .then((machineStarted) => {
        _createBrokerLog(machineStarted, 'Started');
        return Machine.update({
          id: machine.id
        }, machineStarted);
      })
      .then((machines) => {
        if (machines[0].user) {
          increaseUsersMachineEndDate({id: machines[0].user});
        }
        return (machines[0]);
      });
  } else {
    return new Promise((resolve, reject) => {
      return reject('Start machine feature is not available on this driver');
    });
  }
}

/**
 * Ask the driver to stop the specified machine
 *
 * @method stopMachine
 * @public
 * @return {Promise[Machine]}
 */
function stopMachine(machine) {

  if (_driver.stopMachine) {
    return _driver.stopMachine(machine)
      .then(() => {
        machine.status = 'stopping';
        return Machine.update({
          id: machine.id
        }, machine);
      })
      .then((machines) => {
        return promisePoller({
          taskFn: () => {
            return machines[0].refresh()
              .then((machineRefreshed) => {

                if (machineRefreshed.status === 'stopped') {
                  return Promise.resolve(machineRefreshed);
                } else {
                  return Promise.reject(machineRefreshed);
                }
              });
          },
          interval: 5000,
          retries: 100
        })
          .catch((errs) => { // If timeout is reached

            let machine = errs.pop(); // On timeout, promisePoller rejects with an array of all rejected promises. In our case, MachineService rejects the still booting machine. Let's pick the last one.

            _createBrokerLog(machine, 'Error waiting to stop machine');
            _terminateMachine(machine);
            throw machine;
          });
      })
      .then((machineStopped) => {
        _createBrokerLog(machineStopped, 'Stopped');
        return Machine.update({
          id: machine.id
        }, machineStopped);
      })
      .then((machines) => {
        if (!machines[0].user) {
          updateMachinesPool();
        }
        return (machines[0]);
      });
  } else {
    return new Promise((resolve, reject) => {
      return reject('Stop machine feature is not available on this driver');
    });
  }
}

function _terminateMachine(machine) {

  if (_driver.destroyMachine) {
    return _driver.destroyMachine(machine)
      .then(() => {
        return Machine.destroy({
          id: machine.id
        });
      })
      .then(() => {
        return _createBrokerLog(machine, 'Deleted');
      });
  }
}

/**
 * Create new machines if needed in the pool. It uses the `ConfigService`
 * variable:
 *  - machinePoolSize: the number of available machine to keep in the pool
 *
 * @method updateMachinesPool
 * @public
 * @return {Promise}
 */
function updateMachinesPool() {
  return assert(!!_driver, driverNotInitializedError)
    .then(() => {

      return Promise.props({
        config: ConfigService.get('machinePoolSize'),
        machineCount: Machine.count({
          status: 'running',
          user: null
        }),
        unassignedMachine: Machine.find({
          user: null
        })
      })
        .then(({config, machineCount, unassignedMachine}) => {

          let machineToCreate = config.machinePoolSize - machineCount;
          let machineToDestroy = machineCount - config.machinePoolSize;
          let machines = null;


          if (machineToDestroy > 0) {
            machines = _.times(machineToDestroy, (index) => _terminateMachine(unassignedMachine[index]));
            _createBrokerLog({
              type: _driver.name()
            }, `Update machine pool from ${machineCount} to ${machineCount - machineToDestroy} (-${machineToDestroy})`);
          } else if (machineToCreate > 0) {
            machines = _.times(machineToCreate, () => _createMachine());
            _createBrokerLog({
              type: _driver.name()
            }, `Update machine pool from ${machineCount} to ${machineCount + machineToCreate} (+${machineToCreate})`);
          }

          return Promise.all(machines);
        })
        .then(() => {
          return _createBrokerLog({
            type: _driver.name()
          }, 'Machine pool updated');
        })
        .catch(() => {
          _createBrokerLog({
            type: _driver.name()
          }, 'Error while updating the pool');
        });
    });
}

/**
 * Check if the specified machine should be terminated and terminate it if so.
 * The machine will be terminated if the machine's endDate is in the past and if
 * the user doesn't use it.
 *
 * @method _shouldTerminateMachine
 * @private
 * @return {null}
 */
function _shouldTerminateMachine(machine) {
  Promise.props({
    isActive: machine.isSessionActive(),
    config: ConfigService.get('neverTerminateMachine'),
    machineToTerminate: Machine.findOne({id: machine.id})
  })
    .then(({isActive, config, machineToTerminate}) => {
      if (!isActive) {
        const now = new Date();
        if (machineToTerminate.endDate < now) {
          if (config.neverTerminateMachine) {
            stopMachine(machineToTerminate);
          } else {
            machineToTerminate.user = null;

            Machine.update(machineToTerminate.id, machineToTerminate)
              .then(() => {
                _terminateMachine(machineToTerminate);
              });
          }
        }
      }
    });
  return null;
}

/**
 * Inform the broker that the user has open a session on his machine.
 * It basically just call `increaseUsersMachineEndDate`.
 *
 * @method sessionOpen
 * @param {User} user The user that open the session
 * @return {Promise}
 */
function sessionOpen(user) {
  return getMachineForUser(user)
    .then((machine) => {
      machine.endDate = null;
      _createBrokerLog(machine, 'Opened')
        .finally(() => {
          return Machine.update(machine.id, machine);
        });

    });
}

/**
 * Inform if the driver used support Credit
 *
 * @method isUserCreditSupported
 * @param {}
 * @return {Boolean}
 */
function isUserCreditSupported() {
  if (_driver.name() === 'aws') {
    return true;
  } else {
    return false;
  }
}

/**
 * Inform the broker that the user's session has ended.
 * It basically just call `increaseUsersMachineEndDate`.
 *
 * @method sessionEnded
 * @param {User} user The user that ended the session
 * @return {Promise}
 */
function sessionEnded(user) {

  let promise = increaseUsersMachineEndDate(user);

  if (isUserCreditSupported()) {
    promise.then(() => {
      return _driver.getUserCredit(user)
        .then((creditUsed) => {
          return User.update({
            id: user.id
          }, {
            credit: creditUsed
          });
        });
    });
  }
  getMachineForUser(user)
    .then((userMachine) => {
      _createBrokerLog(userMachine, 'Closed');
    });
  return promise;
}

/**
 * Return the list of machines with the status attribute up to date.
 *
 * @method machines
 * @return {Promise[[]Object]}
 */
function machines() {
  return Machine.find({
    type: _driver.name()
  })
    .then((machines) => {
      machines = machines.map((machine) => {
        machine = machine.toObject();
        return _driver.getServer(machine.id)
          .then((server) => {
            machine.status = server.status;
            return machine;
          });
      });
      return Promise.all(machines);
    });
}

/*
 * Create an image from a machine
 * The image will be used as default image for future execution servers
 *
 * @method createImage
 * @param {Object} Image object with `buildFrom` attribute set to the machine id to create image from
 * @return {Promise[Image]} resolves to the new default image
 */
function createImage(image) {
  return _driver.createImage(image);
}

/*
 * Return default image to create instance from
 *
 * @method getDefaultImage
 * @return {Promise[Image]} the default image
 */
function getDefaultImage() {

  return Image.findOne({
    default: true
  });
}

/*
 * Create a new broker log
 *
 * @method _createBrokerLog
 * @param {Machine} the machine to log
 * @param {string} the state to save (created, deleted, opened, ...)
 * @return {Promise} created log
 */
function _createBrokerLog(machine, state) {
  return Machine.count({
    status: 'running'
  })
    .then((nbrMachines) => {
      return BrokerLog.create({
        userId: machine.user,
        machineId: machine.id,
        machineDriver: machine.type,
        machineFlavor: machine.flavor,
        state: state,
        poolSize: nbrMachines
      });
    });
}

/**
 * Retrieve the machine's data
 *
 * @method refresh
 * @param {machine} Machine model
 * @return {Promise[Machine]}
 */
function refresh(machine) {
  return _driver.refresh(machine);
}

/**
 * Retrieve the machine's password
 *
 * @method getPassword
 * @param {machine} Machine model
 * @return {Promise[String]}
 */
function getPassword(machine) {
  return _driver.getPassword(machine);
}

/**
 * Reboot the machine
 *
 * @method rebootMachine
 * @param string Id of the machine
 * @return {Promise[Object]}
 */
function rebootMachine(machine) {
  return _driver.rebootMachine(machine)
    .then((rebootedMachine) => {

      return promisePoller({
        taskFn: () => {
          return rebootedMachine.refresh()
            .then((refreshedMachine) => {

              if (refreshedMachine.status === 'running') {
                _createBrokerLog(refreshedMachine, 'Rebooted');
                return Promise.resolve(refreshedMachine);
              } else {
                return Promise.reject(refreshedMachine);
              }
            });
        },
        interval: 5000,
        retries: 100
      })
        .catch((errs) => { // If timeout is reached

          let machine = errs.pop(); // On timeout, promisePoller rejects with an array of all rejected promises. In our case, MachineService rejects the still booting machine. Let's pick the last one.

          _createBrokerLog(machine, 'Error waiting for machine to reboot');
          throw machine;
        });
    });
}

module.exports = {
  initialize, getMachineForUser, driverName, sessionOpen, sessionEnded,
  machines, createImage, getDefaultImage, refresh, getPassword,
  rebootMachine, startMachine, stopMachine, updateMachinesPool
};
