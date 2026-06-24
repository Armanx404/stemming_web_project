'use strict';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function softDeletePlugin(schema, { field = 'deletedAt' } = {}) {
  schema.add({
    [field]: {
      type: Date,
      default: null,
      index: true,
    },
  });

  schema.pre(/^find/, function excludeSoftDeleted(next) {
    if (!hasOwn(this.getFilter(), field)) {
      this.where({ [field]: null });
    }
    next();
  });

  schema.pre('countDocuments', function excludeSoftDeletedFromCount(next) {
    if (!hasOwn(this.getFilter(), field)) {
      this.where({ [field]: null });
    }
    next();
  });
}

export default softDeletePlugin;
