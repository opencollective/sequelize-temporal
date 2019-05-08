var _ = require('lodash');

var temporalDefaultOptions = {
  // runs the insert within the sequelize hook chain, disable
  // for increased performance
  blocking: true,
  full: false,
  modelSuffix: 'History',
  addAssociations: false
};

var Historical = function(model, sequelize, historyOptions) {
  historyOptions = _.extend({},temporalDefaultOptions, historyOptions);

  var Sequelize = sequelize.Sequelize;

  var historyName = model.name + historyOptions.modelSuffix;

  var historyOwnAttrs = {
    hid: {
      type:          Sequelize.BIGINT,
      primaryKey:    true,
      autoIncrement: true,
      unique: true
    },
    archivedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW
    }
  };

  var excludedAttributes = ["Model","unique","primaryKey","autoIncrement", "set", "get", "_modelAttribute"];
  var historyAttributes = _(model.rawAttributes).mapValues(function(v){	
    v = _.omit(v, excludedAttributes);
    // remove the "NOW" defaultValue for the default timestamps
    // we want to save them, but just a copy from our master record
    if(v.fieldName == "createdAt" || v.fieldName == "updatedAt"){
      v.type = Sequelize.DATE;
    }
    return v;
  }).assign(historyOwnAttrs).value();
  // If the order matters, use this:
  //historyAttributes = _.assign({}, historyOwnAttrs, historyAttributes);

  var historyOwnOptions = {
    timestamps: false
  };
  var excludedNames = ["name", "tableName", "sequelize", "uniqueKeys", "hasPrimaryKey", "hooks", "scopes", "instanceMethods", "defaultScope"];
  var modelOptions = _.omit(model.options, excludedNames);
  var historyModelOptions = _.assign({}, modelOptions, historyOwnOptions);
  
  // We want to delete indexes that have unique constraint
  var indexes = historyModelOptions.indexes;
  if(Array.isArray(indexes)){
     historyModelOptions.indexes = indexes.filter(function(index){return !index.unique && index.type != 'UNIQUE';});
  }

  var modelHistory = sequelize.define(historyName, historyAttributes, historyModelOptions);
  modelHistory.originModel = model;
  modelHistory.addAssociations = historyOptions.addAssociations; 

  // we already get the updatedAt timestamp from our models
  var insertHook = function(obj, options){
    var dataValues = (!historyOptions.full && obj._previousDataValues) || obj.dataValues;
    var historyRecord = modelHistory.create(dataValues, {transaction: options.transaction});
    if(historyOptions.blocking){
      return historyRecord;
    }
  }
  
  var insertBulkHook = function(options){
    if(!options.individualHooks){
      var queryAll = model.findAll({where: options.where, transaction: options.transaction}).then(function(hits){
        if(hits){
          hits = _.map(hits, 'dataValues');
          return modelHistory.bulkCreate(hits, {transaction: options.transaction});
        }
      });
      if(historyOptions.blocking){
        return queryAll;
      }
    }
  }

  var beforeSync = function(options) {
	const source = this.originModel;	
	const sourceHist = this;

	if(source && !source.name.endsWith(historyOptions.modelSuffix) && source.associations && historyOptions.addAssociations == true && sourceHist) {
		const pkfield = source.primaryKeyField;
		//adding associations from history model to origin model's association
		Object.keys(source.associations).forEach(assokey => {			
			const association = source.associations[assokey];				
			const associationOptions = _.cloneDeep(association.options);
			const target = association.target;
			const assocName = association.associationType.charAt(0).toLowerCase() + association.associationType.substr(1);				

			//handle premary keys for belongsToMany
			if(assocName == 'belongsToMany') {								
				sourceHist.primaryKeys = _.forEach(source.primaryKeys, (x) => x.autoIncrement = false);
				sourceHist.primaryKeyField = Object.keys(sourceHist.primaryKeys)[0];
			}

			sourceHist[assocName].apply(sourceHist, [target, associationOptions]);			
		});

		//adding associations between origin model and history					
		source.hasMany(sourceHist, { foreignKey: pkfield });
		sourceHist.belongsTo(source, { foreignKey: pkfield });	
		
		sequelize.models[sourceHist.name] = sourceHist;			
	}

	return Promise.resolve('Historical associations established');
  }
  
  // use `after` to be nonBlocking
  // all hooks just create a copy
  if (historyOptions.full) {
    model.addHook('afterCreate', insertHook);
    model.addHook('afterUpdate', insertHook);
    model.addHook('afterDestroy', insertHook);
    model.addHook('afterRestore', insertHook);
  } else {
    model.addHook('beforeUpdate', insertHook);
    model.addHook('beforeDestroy', insertHook);
  }

  model.addHook('beforeBulkUpdate', insertBulkHook);
  model.addHook('beforeBulkDestroy', insertBulkHook);

  var readOnlyHook = function(){
    throw new Error("This is a read-only history database. You aren't allowed to modify it.");    
  };

  modelHistory.addHook('beforeUpdate', readOnlyHook);
  modelHistory.addHook('beforeDestroy', readOnlyHook);
  modelHistory.addHook('beforeSync', 'HistoricalSyncHook', beforeSync); 

  return model;
};

module.exports = Historical;
