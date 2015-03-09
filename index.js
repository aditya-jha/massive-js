var Runner = require("./lib/runner");
var _ = require("underscore")._;
var fs = require("fs");
var Table = require("./lib/table");
var util = require("util");
var assert = require("assert");
var Document = require("./lib/document");
var ArgTypes = require("./lib/arg_types");
var Args = require("args-js");
var path = require("path");
var self;

var Massive = function(args){

  this.scriptsDir = args.scripts || process.cwd() + "/db";
  
  var runner = new Runner(args.connectionString);
  _.extend(this,runner);

  this.tables = [];
  this.queryFiles = [];
  this.schemas = [];
  //console.log("Massive online", this);
}

Massive.prototype.run = function(){
  var args = ArgTypes.queryArgs(arguments);
  this.query(args);
}
 
Massive.prototype.loadQueries = function() { 
  walkSqlFiles(this,this.scriptsDir);
};

Massive.prototype.loadTables = function(next){
  var tableSql = __dirname + "/lib/scripts/tables.sql";
  var self = this;
  this.executeSqlFile({file : tableSql}, function(err,tables){
    if(err){
      next(err,null);
    }else{
      _.each(tables, function(table){
        var _table = new Table({
          schema : table.schema,
          name : table.name,
          pk : table.pk,
          db : self
        });
        // This refactoring appears to work well:
        MapTableToNamespace(_table);
      });
      next(null,self);
    }
  });
}

// This works with schemas now, but it's ugly code. I'll need to refactor. 
Massive.prototype.saveDoc = function(collection, doc, next){
  var self = this;

  // default is public. Table constructor knows what to do if 'public' is used as the schema name:
  var schemaName = "public";
  var tableName = collection;
  var tableExists = true;

    // is the collection namespace delimited?
  var splits = collection.split(".");
  if(splits.length > 1) {
    // uh oh. Someone specified a schema name:
    schemaName = splits[0];
    tableName = splits[1];
    if(!self[schemaName][tableName]) { 
      tableExists = false;
    } else { 
      self[schemaName][tableName].saveDoc(doc,next);
    }
  } else { 
    if(!self[tableName]) { 
      tableExists = false;
    } else { 
      self[tableName].saveDoc(doc,next);
    }
  }

  // This is clunky too. Clean this up somehow!!
  if(!tableExists) { 
    var _table = new Table({
    schema : schemaName,
     pk : "id",
     name : tableName,
     db : self
    });

    // Create the table in the back end:
    var sql = this.documentTableSql(collection);
    this.query(sql, function(err,res){
      if(err){
        next(err,null);
      } else {
        MapTableToNamespace(_table);
        // recurse
        self.saveDoc(collection,doc,next);       
      }
    });
  }
};

var MapTableToNamespace = function(table) { 
  var db = table.db;
  if(table.schema !== "public") { 
    schemaName = table.schema;
    // is this schema already attached?
    if(!db[schemaName]) { 
      // if not, then bolt it on:
      db[schemaName] = {};
      // push it into the tables collection as a namespace object:
      db.tables.push(db[schemaName]);
    }
    // attach the table to the schema:
    db[schemaName][table.name] = table;
  } else { 
    //it's public - just pin table to the root to namespace
    db[table.name] = table;
    db.tables.push(table);
  }  
}

Massive.prototype.documentTableSql = function(tableName){
  var docSqlFile = __dirname + "/lib/scripts/create_document_table.sql";
  var sql = fs.readFileSync(docSqlFile, {encoding: 'utf-8'});

  var indexName = tableName.replace(".", "_");
  sql = util.format(sql, tableName, indexName, tableName);
  return sql;
};

//A recursive directory walker that would love to be refactored
var walkSqlFiles = function(rootObject, rootDir){
  var dirs;
  try {
    dirs = fs.readdirSync(rootDir);
  } catch (ex) {
     return;
  }
  
  //loop the directories found
  _.each(dirs, function(item){

    //parsing with path is a friendly way to get info about this dir or file
    var parsed = path.parse(item);

    //is this a SQL file?
    if(parsed.ext === ".sql"){

      //why yes it is! Build the abspath so we can read the file
      var filePath = path.join(rootDir,item);

      //pull in the SQL - don't worry this only happens once, when
      //massive is loaded using connect()
      var sql = fs.readFileSync(filePath, {encoding : "utf-8"});

      //set a property on our root object, and grab a handy variable reference:
      var newProperty = assignScriptAsFunction(rootObject, parsed.name);

      //I don't know what I'm doing, but it works
      newProperty.sql = sql;
      newProperty.db = self;
      newProperty.filePath = filePath;
      self.queryFiles.push(newProperty);

    }else if(parsed.ext !== ''){
      //ignore it
    }else{

      //this is a directory so shift things and move on down
      //set a property on our root object, then use *that*
      //as the root in the next call
      rootObject[parsed.name] = {};

      //set the path to walk so we have a correct root directory
      var pathToWalk = path.join(rootDir,item);

      //recursive call - do it all again
      walkSqlFiles(rootObject[parsed.name],pathToWalk);
    }
  });
}

//it's less congested now...
var assignScriptAsFunction = function (rootObject, propertyName) { 
   rootObject[propertyName] = function(args, next) { 
    args || (args = {});
    //if args is a function, it's our callback
    if(_.isFunction(args)){
      next = args;
      //set args to an empty array
      args = [];
    }
    //JA - use closure to assign stuff from properties before they are invented 
    //(sorta, I think...):
    var sql = rootObject[propertyName].sql;
    var db = rootObject[propertyName].db;
    var params = _.isArray(args) ? args : [args];

    //execute the query on invocation
    db.query(sql,params,{}, next);  
  }
  return rootObject[propertyName];
}

//connects Massive to the DB
exports.connect = function(args, next){
  assert((args.connectionString || args.db), "Need a connectionString or db (name of database on localhost) at the very least.");
  
  //override if there's a db name passed in
  if(args.db){
    args.connectionString = "postgres://localhost/"+args.db;
  }

  var massive = new  Massive(args);

  //load up the tables, queries, and commands
  massive.loadTables(function(err,db){
    self = db;
    assert(!err, err);
    //synchronous
    db.loadQueries();
    next(null,db);
  });
};
