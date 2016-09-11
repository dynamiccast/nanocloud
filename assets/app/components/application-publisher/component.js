import Ember from 'ember';
import fileExplorer from 'nanocloud/components/file-explorer/component';

export default fileExplorer.extend({
  publishError: false,

  loadDirectory() {
    this.set('selectedFile', null);
    this._super(...arguments);
  },

  publishSelectedFile() {

    let name = this.get('selectedFile').get('name').replace(/\.[^/.]+$/, '');

    let m = this.get('store').createRecord('app', {
      alias: name,
      displayName: name,
      collectionName: 'collection',
      filePath: this.get('pathToString') + this.get('selectedFile.name')
    });

    this.set('isPublishing', true);
    m.save()
      .then(() => {
        this.set('isPublishing', false);
        this.toast.success('Your application has been published successfully');
        this.sendAction('action');
      }, (error) => {
        this.set('isPublishing', false);
        this.set('publishError', true);
        this.set('selectedFile', null);
        this.toast.error(error.errors[0].status + ' : ' + error.errors[0].title);
      });
  },

  selectFile(file) {
    if (this.get('selectedFile') !== file) {
      this.set('selectedFile', file);
    }
    else {
      this.set('selectedFile', null);
    }
  },

  selectedFilePath: Ember.computed('pathToString', 'selectedFile', function() {
    return (this.get('pathToString') + this.get('selectedFile').get('name'));
  }),

  actions: {

    clickItem(item) {
      if (item.get('isDir')) {
        this.selectDir(item.get('name'));
      } else {
        this.selectFile(item);
      }
    },

    clickPublish() {
      this.publishSelectedFile();
    },

    clickPublish() {
      this.publishSelectedFile();
    },
  }
});
