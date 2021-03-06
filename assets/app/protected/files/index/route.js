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
 * You should have received a copy of the GNU Affero General
 * Public License
 * along with this program.  If not, see
 * <http://www.gnu.org/licenses/>.
 */

import Ember from 'ember';

export default Ember.Route.extend({
  setupController(controller, model) {
    controller.set('items', model);
  },

  model() {
    return this.get('store').query('file', {})
      .catch((err) => {
        if (err.errors.length === 1 && err.errors[0].code === '000007') {
          this.toast.warning('Cannot list files because Windows is not running');
          this.transitionTo('protected.files.nowindows');
        } else if (err.errors.length === 1 && err.errors[0].code === '000008') {
          this.toast.warning('You need to login once to an application to activate this feature');
          this.transitionTo('protected.files.notactivated');
        } else {
          return this.send('error', err);
        }
      });
  },

  actions: {
    refreshModel() {
      this.refresh();
    },
  }
});
