/*
 * Copyright (c) 2014, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

(function () {
    var loggerContext = "CompletionEngine";

    //Aliases for the attribute names used in 'CompletionEngine.extensions' and 'CompletionEngine.system' json objects
    var FUNCTIONS = "functions";
    var STREAM_PROCESSORS = "streamProcessors";
    var WINDOW_PROCESSORS = "windowProcessors";

    // Following keyword lists are repeated in many functions
    var logicalOperatorList = ["IN", "AND", "OR", "NOT", "isNull(arg)", "IS NULL", "CONTAINS"];
    var dataTypes = ["int", "float", "double", "bool", "time", "object", "string", "long"];

    // Set of regular expressions
    var identifier = "[a-zA-Z_][a-zA-Z_0-9]*";
    var anyChar = "(.|\\n)";
    var oneDataType = "(int|long|double|bool|object|string|time)";
    var queryActions = "insert|delete|update";
    var querySelection = "select";
    var queryOutput = "output";
    var groupBY = "(group\\s+by)";
    var having = "having";
    var queryInput = "((?!(" + querySelection + "|" + queryOutput + "|" + queryActions + "|" + having + "|" + groupBY + ")).)*";
    var querySection = "((?!(" + queryOutput + "|" + queryActions + ")).)*";
    var outputRate = "((?!(every|" + queryActions + ")).)*";
    var outputRateEvery = "((?!(" + queryActions + ")).)*";

    /*
     *  'ruleBase' has a list of regular expressions to identify the different contexts and appropriate handlers to generate context aware suggestions.
     *
     *   RULES HAVE DIFFERENT FORMAT
     *   ---------------------------
     *
     *          if the suggestions list is a simple keyword list (ex : suggestions list after 'define' keyword)
     *          ------------------------------------------------
     *                 {
     *                    regex : "regularExpression",
     *                    next : ["list" ,"of", "keywords"]
     *                 }
     *
     *
     *          if the suggestions list dynamically calculated (Ex : suggestions list after the 'from' keyword)
     *          ----------------------------------------------
     *                 {
     *                    regex : "regularExpression",
     *                    next : "CompletionEngine.$FunctionHandler"   // CONVENTION : function name is started with $ mark
     *                 }
     *
     *
     *          if the context cannot be identified using regular expressions ( Ex : nested structures which cannot be identified using regex)
     *          -------------------------------------------------------------
     *                 {
     *                    cfg : "CompletionEngine._checkNestedBrackets", // CONVENTION : function name is started with _
     *                    next : "CompletionEngine.$FunctionHandler"
     *                 }
     ************/
    var ruleBase = [
        {
            regex: "@(p(l(a(n?)?)?)?)((?![)]).)*$",
            next: ['Plan:name(\'Name of the plan\')', 'Plan:description(\'Description of the plan\')', 'Plan:trace(\'true|false\')', 'Plan:statistics(\'true|false\')', 'Import(\'StreamName\')', 'Export(\'StreamName\')']
        },
        {
            regex: "@\\w*((?![)]).)*$",
            next: ['Config(async=true)', 'info(name=\'stream_id\')', 'Plan:name(\'Name of the plan\')', 'Plan:description(\'Description of the plan\')', 'Plan:trace(\'true|false\')', 'Plan:statistics(\'true|false\')', 'Import(\'StreamName\')', 'Export(\'StreamName\')']
        },
        {
            regex: "\\0$",
            next: "$initialList"
        },
        {
            regex: "\\s+in\\s+$",
            next: "$TableSuggestions"
        },
        {
            regex: "from\\s+" + queryInput + "#window\\.$",
            next: "$windowPhrase"
        },
        {
            regex: "from\\s+" + queryInput + "#(.)+:$",
            next: "$nameSpacePhrase"
        },
        {
            regex: "(\\w+)\\:$",
            next: "$nameSpacePhrase"
        },
        {
            regex: "(\\w+)\\[\\s*(\\d+|last|last-\\d+)\\s*\\]\\.$",
            next: "$eventReferenceHandler"
        },
        {
            regex: "(\\w+)\\.$",
            next: "$resolveVariable"
        },
        {
            regex: "from\\s+" + queryInput + "#\\w*$",
            next: "$processorPhrase"
        },
        {
            regex: "insert\\s+((?!(into|;)).)*$",
            next: ["into", "events", "all", "current", "expired"]
        },
        {
            regex: "insert(.)*into((?!(;)).)*$",
            next: "$TableSuggestions"
        },
        {
            regex: "from.*(delete|update)((?!(on|for)).)*$",
            next: "$UDPhrase" //for,on,tablenames
        },
        {
            regex: "from.*(delete|update)\\s+" + identifier + "\\s+for((?!on).)*$",
            next: ["all", "current", "expired", "events", "on"]   //all , current, expired , events .
        },
        {
            regex: "from.*(delete|update)\\s+(" + identifier + ").*on.*((?!;).)*$",
            next: "$UDConditionPhrase"
        },
        {
            regex: "partition\\s+$",
            next: ["with"]
        },
        {
            regex: "partition\\s+with\\s+[(](\\s*" + identifier + "\\s+of\\s+" + identifier + "\\s*[,])*\\s*$",
            next: "$allAttributeList"
        },
        {
            regex: "partition\\s+with\\s+[(](\\s*" + identifier + "\\s+of\\s+" + identifier + "\\s*[,])*\\s*" + identifier + "\\s+$",
            next: ["of"]
        },
        {
            regex: "partition\\s+with\\s+[(](\\s*" + identifier + "\\s+of\\s+" + identifier + "\\s*[,])*\\s*" + identifier + "\\s+of\\s+$",
            next: "$partitionStreamList"
        },
        {
            regex: "define\\s*((?!(stream|table|function)).)*$",
            next: ["stream", "table", "function"]
        },
        {
            regex: "define\\s+function\\s+" + identifier + "\\s+$",
            next: [" [language_name] "]
        },
        {
            regex: "define\\s+function\\s+" + identifier + "\\s+\\[\\s*\\w+\\s*\\]\\s+$",
            next: ["return"]
        },
        {
            regex: "define\\s+function\\s+" + identifier + "\\s+\\[\\s*\\w+\\s*\\]\\s+return\\s+$",
            next: dataTypes
        },
        {
            regex: "define\\s+function\\s+" + identifier + "\\s+\\[\\s*\\w+\\s*\\]\\s+return\\s+" + oneDataType + "\\s+$",
            next: ["{ \"Function Body\"  }"]
        },
        {
            regex: "define\\s+(stream|table)\\s+" + identifier + "\\s*[(](\\s*" + identifier + "\\s+\\w+\\s*[,])*\\s*" + identifier + "\\s+((?!(int|string|float|object|time|bool|[,]|;))" + anyChar + ")*$",
            next: dataTypes
        },
        {
            regex: "from.*(select)?.*" + groupBY + "?.*having" + querySection + "$", //output | insert | delete | update is possible
            next: "$selectPhraseHaving"
        },
        {
            regex: "from.*(select)?.*" + groupBY + "\\s+" + querySection + "$", // having | output | insert| delete | update is possible
            next: "$selectPhraseGroupBy"
        },
        {
            regex: "from(.)*\\[((?!\\]).)*$",
            next: "$filterPhrase"
        },
        {
            cfg: "_checkNestedSquareBracketInFROMPhrase",
            next: "$filterPhrase"
        },
        {
            regex: "from\\s+" + queryInput + "$",    //group by , having , output    join ,on "expired events   "from\\s+((?!select).)*$"
            next: "$fromPhraseStreamIdList"
        },
        {
            regex: "from(.)*select\\s+" + querySection + "$",             //output ,group by , having , insert, delete , update
            next: "$selectPhraseAttributesList"
        },
        {
            regex: "from(.)*output\\s+" + outputRate + "$",             //insert, delete , update
            next: ["snapshot", "all", "last", "first", "every"]
        },
        {
            regex: "from(.)*output.*every" + outputRateEvery + "$",             //insert, delete , update
            next: ["events", "min", "hours", "weeks", "days", "months", "years", "insert", "delete", "update"]
        }
    ];

    window.CompletionEngine = function() {
        var self = this;

        //List of streams that would keep the meta data of the streams defined/inferred within the query.
        self.streamList = new StreamList();

        //List of tables that would keep the meta data of the tables defined within the query.
        self.tableList = new TableList();

        //List of functions that would keep the meta data of the functions defined within the query.
        self.functionList = new FunctionList();

        //stream aliases in query are stored as a list of  aliasName:streamID .
        // ex :
        //  query
        //  -----
        //  from streamB as myStream join streamA as foo ...
        //
        //  representation
        //  --------------
        //  streamAliasList={
        //    myStream : streamB,
        //         foo : streamA
        //  }
        self.streamAliasList = {};

        //Event references in a query are stored as a list of  aliasName:streamID .
        // ex :
        //  query
        //  -----
        //  from e1=streamB -> e2=streamA ...
        //
        //  representation
        //  --------------
        //  eventStore ={
        //    e1 : streamB,
        //    e2 : streamA
        //  }
        self.eventStore = {};

        // CompletionEngine.wordList is the current suggestions list . This is an array of objects with following format
        // {
        //       definition:"suggestion name",
        //       value : "suggestion value"
        //       score : 2,
        //       meta : "keyword"
        // }
        self.wordList = [];

        //SiddhiCompleter is attached with ext-language module. So that Ace editor library will be using this module for generate suggestions
        self.SiddhiCompleter = {
            getCompletions: function (editor, session, pos, prefix, callback) {

                self.calculateCompletions(editor); //calculate the suggestions list for current context
                self.checkTheBeginning(editor);

                //This completer will be using the wordList array
                //context-handler functions will be updated the the worldList based on the context arround the cursor position
                callback(null, self.wordList.map(function (ea) {
                    return {definition: ea.value, value: ea.word, score: ea.score, meta: "intelli"};
                }));
            }
        };

        //'extension' json object contains the custom function,streamProcessor and windowProcessor extensions available for
        // the current Siddhi Session. Currently the extensions listed in the documentation are listed below.
        // But this data structure should be dynamically pull down from the backend services.
        /*
         * SCHEMA
         * ------
         *    extensions={
         *       namespace1:{
         *                  functions:{
         *                              function1:[  // array is used here to allow multiple representations of the same function
         *                                          {
         *                                              Description: "description of the function1",
         *                                              argNames: ["p1"],
         *                                              argTypes: [["float", "double"]],
         *                                              returnType: ["float", "double"]
         *                                          }
         *                              ],
         *                              function2:[
         *                                          {
         *                                              //representation of the function2
         *                                          }
         *                              ]
         *                  },
         *                  streamProcessors:{
         *                         // Same as in function section
         *                  }  ,
         *                  windowProcessors:{
         *                          // same as in function section
         *                  }
         *       },
         *
         *       namespace2:{
         *                  functions:{
         *
         *                  },
         *
         *                  streamProcessors:{
         *                         // Same as in function section
         *                  }
         *                  ,
         *
         *                  windowProcessors:{
         *                          // same as in function section
         *                  }
         *       }
         *
         *
         *    }
         *
         *
         * */
        self.extensions = {};

        // System json object contains the inbuilt function,streamProcessor and windowProcessor  available for the current Siddhi Session
        self.system = {};

        /*************************************************************************************************************************
         *                                          Integration functions for Completion-Engine module
         *************************************************************************************************************************/

        /**
         * Dynamically select the completers suitable for current context
         *
         * @param editor : ace editor instance
         * @returns {Array|*} : suitable completer list for current context
         */
        self.adjustAutoCompletionHandlers = function (editor) {
            // NOTE:  adjustAutoCompletionHandlers() method will be called in      js/ace_editor/ext-language_tools.js. as follows
            //
            //  Autocomplete.startCommand = {
            //           name: "startAutocomplete",
            //           exec: function(editor) {
            //                     if (!editor.completer)
            //                        editor.completer = new Autocomplete();
            //
            //  ------>            editor.completionEngine.adjustAutoCompletionHandlers(editor);
            //
            //                     editor.completer.autoInsert = false;
            //                     editor.completer.autoSelect = true;
            //                     editor.completer.showPopup(editor);
            //                     editor.completer.cancelContextMenu();
            //                 },
            //           bindKey: "Ctrl-Space|Ctrl-Shift-Space|Alt-Space"
            //      };
            //
            // This method will dynamically select the appropriate completer for current context when auto complete event occurred.

            var completerList = [];
            if (this.checkTheBeginning(editor)) {
                //if the cursor is positioned at the beginning of new statement(query), then show the suggestions from the
                //SiddhiCompleter and snippetCompleter

                completerList = [SiddhiEditor.langTools.snippetCompleter, this.SiddhiCompleter];
            } else {
                //if the cursor is placed in the middle of the statement

                if (this.checkVariableResolveness(editor)) {
                    //if the last token is the dot operator => only the attributes of the object/namespace should be listed
                    //so that just show the suggestions from the SiddhiComplreter
                    completerList = [this.SiddhiCompleter];
                }
                else {
                    //if the cursor is in the middle of a query and not preceded by a dot operator
                    //show the keywords, and suggestions from the SiddhiCompleter.
                    completerList = [SiddhiEditor.langTools.keyWordCompleter, this.SiddhiCompleter];
                }
            }

            editor.completers = completerList;
        };

        /**
         * Check whether the cursor is positioned next to a dot operator or namespace operator
         *
         * @param editor : ace editor instance
         * @returns boolean : true if the cursor is positioned just after the dot operator or namespace operator
         */
        self.checkVariableResolveness = function (editor) {
            var objectNameRegex = /\w*\.$/i;
            var namespaceRegex = /\w*:$/i;
            var txt = editor.getValue();
            return !!(objectNameRegex.test(txt) || namespaceRegex.test(txt));

        };

        /**
         * Check whether the cursor is positioned at the beginning of a query
         *
         * @param editor : ace editor instance
         * @returns : true if the cursor is positioned at the beginning.
         */
        self.checkTheBeginning = function (editor) {
            var position = editor.getCursorPosition();
            var lineNumber = position.row;
            var currentLine = editor.session.getLine(lineNumber);
            var txt = editor.session.doc.getTextRange(SiddhiEditor.Range.fromPoints({
                row: 0,
                column: 0
            }, position));  // all the text up to the cursor position.

            var tailingSpaces = /^\s*/i;
            var tail = currentLine.substring(position.column); //rest of the line

            if (tailingSpaces.test(tail)) {
                //if the rest of the line after the cursor has only the whitespaces.

                //set of regular expressions to identify the beginning of the statement
                var name = identifier + "(\\." + identifier + ")*";
                var annotationElement = "(" + name + "\\s*[=]\\s*)?[\"'](.)+[\"']";
                var newStatement = /;\s+\S*$/i;
                var blockCommentEnd = /[*][/]\s*\S*$/i; // just after the block comment
                var lineComment = /--(.)*\s+\S*$/i;     // just after the line comment
                var begin = /begin\s*\S*$/i;            // within the partition statement. just after the begin keyword
                var spaces = /^\s*$/;
                var startingWord = /^\s*\S*$/i;         //spaces followed by non-space characters
                var annotationBody = name + "\\s*[(]\\s*" + annotationElement + "(\\s*[,]\\s*" + annotationElement + ")*\\s*[)]\\s*\\S*$";
                var annotation = new RegExp("@\\s*" + annotationBody, "i");                     //annotation element
                var planAnnotations = new RegExp("@\\s*plan\\s*:\\s*" + annotationBody, "i");   //Regular expression for plan-annotations.

                if (newStatement.test(txt) || annotation.test(txt) || planAnnotations.test(txt) || blockCommentEnd.test(txt) || lineComment.test(txt) || begin.test(txt) || spaces.test(txt) || txt == "" || startingWord.test(txt)) {

                    if (SiddhiEditor.debug) {
                        console.warn(loggerContext + ":" + "checkTheBeginning" + "->");
                        console.log("New statement is suitable for current position");
                    }
                    return true;
                }
            }
            return false;
        };

        /**
         * Calculate the list of suggestions based on the context around the cursor position
         *
         * @param editor : ace editor instance
         *
         */
        self.calculateCompletions = function (editor) {
            var pos = editor.getCursorPosition();   //cursor position
            var text = editor.session.doc.getTextRange(SiddhiEditor.Range.fromPoints({
                row: 0,
                column: 0
            }, pos));                               //all the text before the cursor position
            var tempStatements = text.split(";");
            text = tempStatements[tempStatements.length - 1]; //get the last statement.

            this.eventStore = {};           //clear the global tables for event references and stream alias
            this.streamAliasList = {};


            text = text.replace(/\s/g, " "); //Replace all the white spaces with single space each.
            // This step is important for identifying the statements span across  multiple lines using regular expressions.
            // Regular expressions listed in 'ruleBase' structure only identify the prefixes span in single line.
            // By replacing newline characters of the input text with spaces, those rules can be used for identifying multiline prefixes.

            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "calculateCompletions" + "->");
                console.log("input text", text);
            }

            this.wordList = [];  //clear the previous suggestion list
            if (this.checkTheBeginning(editor)) {
                this.wordList = this.$initialList();
            }


            for (var a = 0; a < ruleBase.length; a++) {
                if (ruleBase[a].hasOwnProperty("cfg")) {
                    if (executeFunctionByName.call(this, ruleBase[a].cfg, [text])) {
                        if (Object.prototype.toString.call(ruleBase[a].next) === '[object Array]') {
                            this.wordList = makeCompletions(ruleBase[a].next)
                        } else {
                            this.wordList = executeFunctionByName.call(this, ruleBase[a].next, [text]);
                        }
                        return;
                    }
                } else {
                    var regx = new RegExp(ruleBase[a].regex, "i");
                    if (regx.test(text)) {
                        if (SiddhiEditor.debug) {
                            console.warn(loggerContext + ":" + "calculateCompletion" + "->");
                            console.log("Matched regular expression : ", text, ruleBase[a]);
                        }

                        if (Object.prototype.toString.call(ruleBase[a].next) === '[object Array]') {
                            this.wordList = makeCompletions(ruleBase[a].next)

                        } else {
                            this.wordList = executeFunctionByName.call(this, ruleBase[a].next, [text, regx]);
                        }

                        if (SiddhiEditor.debug) {
                            console.warn(loggerContext + ":" + "calculateCompletion" + "->");
                            console.log("Generated suggestion List", this.wordList);
                        }

                        return;
                    }
                }
            }
        };


        /*************************************************************************************************************************
         *                                          Context identification functions
         *************************************************************************************************************************/

        self._checkNestedSquareBracketInFROMPhrase = function (arg) {
            var fromRegxp = /from((?:.(?!from))+)$/i;
            var fromPhrase = fromRegxp.exec(arg[0]);
            if (fromPhrase == null) {
                return false;
            }

            var bracketCouter = 0;
            for (var index = fromPhrase[1].length - 1; index >= 0; index--) {

                if (fromPhrase[1].charAt(index) == '[')
                    bracketCouter++;
                else if (fromPhrase[1].charAt(index) == ']')
                    bracketCouter--;

                if (bracketCouter > 0)
                    return true;
            }
            return false;
        };


        /*************************************************************************************************************************
         *                                          Auto completions context-handler functions
         *************************************************************************************************************************/

        self.$initialList = function () {
            var intialArray = ["define", "from", "partition", "@"];
            return makeCompletions(intialArray)
        };
        self.$fromPhraseStreamIdList = function (args) {
            var tempList = [];
            var essentialKeyWords = [
                "output", "outer", "inner", "left", "unidirectional", "all", "events", "insert",
                "delete", "update", "select", "as", "join", "on", "every", "group by", "having", "within"
            ];
            var streams = this.streamList.getStreamIDList();

            this.$eventReference(args[0]);
            var refList = getEventReferences();
            refList = refList.map(function (d) {
                return d + ".";
            });


            this.$streamAlias(args[0]);
            var aliasList = getStreamAliasList();
            aliasList = aliasList.map(function (d) {
                return d + ".";
            });


            essentialKeyWords = makeCompletions(essentialKeyWords, 2);
            streams = makeCompletions(streams, 3);
            refList = makeCompletions(refList, 4);
            aliasList = makeCompletions(aliasList, 5);


            tempList = tempList.concat(essentialKeyWords);
            tempList = tempList.concat(aliasList);
            tempList = tempList.concat(streams);
            tempList = tempList.concat(refList);

            return tempList;
        };
        self.$selectPhraseAttributesList = function (args) {
            // Stream Alias yet to be handled , both in 'stream as e' form and "e1=stream"
            var keyWords = ["as", "insert", "group by", "having", "output", "update", "delete"];


            var sysFunctions = getSystemFunctionNames();
            sysFunctions = sysFunctions.map(function (d) {
                return d + "(args)";
            });


            var ns = getExtensionNamesSpaces(FUNCTIONS);
            ns = ns.map(function (d) {
                return d + ":";
            });


            var tableList = this.tableList.getTableIDList();
            tableList = tableList.map(function (d) {
                return d + ".";
            });


            var result = args[1].exec(args[0]);
            var streamNames = this.streamList.getStreamIDList();
            var fromPhrase = /from(.*)select/i.exec(result[0]);

            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$selectPhraseAttributesList" + "->");
                console.log("From Phrase", fromPhrase);
            }


            this.$streamAlias(result[0]);
            var aliasList = getStreamAliasList();
            aliasList = aliasList.map(function (d) {
                return d + ".";
            });

            this.$eventReference(result[0]);
            var refList = getEventReferences();
            refList = refList.map(function (d) {
                return d + ".";
            });

            var streamIds = [];
            var list = [];
            for (var index = 0; index < streamNames.length; index++) {
                var regex = new RegExp("[^a-zA-Z]" + streamNames[index] + "[^a-zA-Z0-9]");

                if (fromPhrase[1].match(regex)) {
                    streamIds.push(streamNames[index]);
                    tempList = this.streamList.getAttributeList(streamNames[index]);

                    list = list.concat(tempList);
                }
            }

            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$selectPhraseAttributesList" + "->");
                console.log("generated list", list);
            }

            streamIds = streamIds.map(function (d) {
                return d + ".";
            });

            streamIds = makeCompletions(streamIds, 5);
            list = makeCompletions(list, 8);
            refList = makeCompletions(refList, 7);
            aliasList = makeCompletions(aliasList, 6);
            tableList = makeCompletions(tableList, 4);
            ns = makeCompletions(ns, 3);
            keyWords = makeCompletions(keyWords, 1);
            sysFunctions = makeCompletions(sysFunctions, 2);


            var tempList = (keyWords.concat(ns));
            tempList = tempList.concat(streamIds);
            tempList = tempList.concat(tableList);
            tempList = tempList.concat(refList);
            tempList = tempList.concat(aliasList);
            tempList = tempList.concat(sysFunctions);
            tempList = tempList.concat(list);
            //insert, Aggregate functions  , as In From phrase , e1.
            return tempList;
        };
        self.$windowPhrase = function (args) {
            var defaultArray = [
                "time(windowTime)", "timeBatch(windowTime)", "timeBatch(windowTime, startTime)",
                "length(windowLength)", "lengthBatch(windowLength)", "externalTime(timeStamp, windowTime)",
                "cron(cronExpression)", "firstUnique(attribute)", "unique(attribute)", "sort(windowLength)",
                "sort(windowLength, attribute, order)", "frequent(eventCount)", "frequent(eventCount, attribute)",
                "lossyFrequent(supportThreshold, errorBound)", "lossyFrequent(supportThreshold, errorBound, attribute)",
                "externalTimeBatch(timeStamp, windowTime, startTime, timeOut)", "timeLength(windowTime, windowLength)",
                "uniqueExternalTimeBatch(attribute, timeStamp, windowTime, startTime, timeout, replaceTimestampWithBatchEndTime)"
            ];


            var nsArray = getExtensionNamesSpaces(WINDOW_PROCESSORS);
            nsArray = nsArray.map(function (d) {
                return d + ":";
            });

            defaultArray = defaultArray.concat(nsArray);
            return makeCompletions(defaultArray);
        };
        self.$processorPhrase = function (args) {
            var defaultArray = ["window."];

            // if built in streamProcessors exist , they should be included

            defaultArray = makeCompletions(defaultArray, 2);

            var nsArray = getExtensionNamesSpaces(WINDOW_PROCESSORS, STREAM_PROCESSORS);
            nsArray = nsArray.map(function (d) {
                return d + ":";
            });

            defaultArray = defaultArray.concat(makeCompletions(nsArray, 1));
            return (defaultArray);
        };


        self.$allAttributeList = function (args) {
            var tempList = [];
            var streamList = this.streamList.getStreamIDList();

            for (var s = 0; s < streamList.length; s++) {

                var attributeList = this.streamList.getAttributeList(streamList[s]);
                tempList = tempList.concat(makeCompletions(attributeList, s));
            }


            return tempList;
        };
        self.$partitionStreamList = function (args) {
            var tempList = [];
            var regx = "(" + identifier + ")\\s+of\\s+\\w*$";
            var identifierResult = (new RegExp(regx)).exec(args[0]);

            var streamList = this.streamList.getStreamIDList();
            for (var i = 0; i < streamList.length; i++) {
                var attributeList = this.streamList.getAttributeList(streamList[i]);
                for (var index = 0; index < attributeList.length; index++) {
                    if (attributeList[index] == identifierResult[1]) {
                        tempList.push(streamList[i]);
                        break;
                    }
                }
            }


            return makeCompletions(tempList);
        };
        self.$TableSuggestions = function (args) {
            return makeCompletions(this.tableList.getTableIDList());

        };
        self.$UDPhrase = function (args) {
            var tempList = ["for", "on"];
            tempList = makeCompletions(tempList, 1);

            var tableList = this.tableList.getTableIDList();
            tempList = tempList.concat(makeCompletions(tableList, 2));
            return tempList;
        };
        self.$UDConditionPhrase = function (args) {
            var keywords = ["IS NULL", "NOT", "AND", "OR"];

            var result = args[1].exec(args[0]);
            var streamNames = this.streamList.getStreamIDList();
            var tableNames = this.tableList.getTableIDList();

            var fromPhrase = /from(.*)(update|delete)/i.exec(result[0]);
            var streamList = [];
            var attributeList = [];
            var regex;
            for (var i = 0; i < streamNames.length; i++) {
                regex = new RegExp("[^a-zA-Z]" + streamNames[i] + "[^a-zA-Z0-9]");

                if (fromPhrase[1].match(regex)) {
                    streamList.push(streamNames[i]);
                    attributeList = attributeList.concat(this.streamList.getAttributeList(streamNames[i]))
                }
            }


            var tempList = [];

            streamList = streamList.map(function (d) {
                return d + "."
            });


            var UDphrase = /(update|delete)(.*)on/i.exec(result[0]);


            var tableList = [];
            for (i = 0; i < tableNames.length; i++) {

                regex = new RegExp("[^a-zA-Z]" + tableNames[i] + "[^a-zA-Z0-9]");

                if (UDphrase[2].match(regex))
                //
                //if( UDphrase[2].indexOf(tableNames[i]))
                    tableList.push(tableNames[i]);
            }

            tableList = tableList.map(function (d) {
                return d + "."
            });

            tempList = tempList.concat(makeCompletions(tableList, 4));
            tempList = tempList.concat(makeCompletions(attributeList, 3));
            tempList = tempList.concat(makeCompletions(streamList, 2));
            tempList = tempList.concat(makeCompletions(keywords, 1));
            return tempList;
        };


        self.$selectPhraseGroupBy = function (args) {
            var keywords = ["output", "having", "insert", "delete", "update"];
            var result = args[1].exec(args[0]);
            var regx = /from(.*)group/i;
            var fromPhrase = regx.exec(result[0]);

            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$selectPhraseGroupBy" + "->");
                console.log("fromPhrase:", fromPhrase);
            }


            //
            var streamNames = this.streamList.getStreamIDList();
            var list = [];
            var templist = [];

            list = list.concat(makeCompletions(keywords, 1));

            for (var index = 0; index < streamNames.length; index++) {
                var regex = new RegExp("[^a-zA-Z]" + streamNames[index] + "[^a-zA-Z0-9]");

                if (fromPhrase[1].match(regex)) {


                    templist = templist.concat(this.streamList.getAttributeList(streamNames[index]));

                }


            }

            streamNames = streamNames.map(function (d) {
                return d + ".";
            });

            list = list.concat(makeCompletions(streamNames), 2);
            list = list.concat(makeCompletions(templist, 3));
            return list;
        };
        self.$selectPhraseHaving = function (args) {
            var keywords = ["output", "insert", "delete", "update"];
            keywords = keywords.concat(logicalOperatorList);
            var result = args[1].exec(args[0]);
            var regx = /from(.*)having/i;
            var fromPhrase = regx.exec(result[0]);

            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$selectPhraseHaving" + "->");
                console.log("fromPhrase:", fromPhrase);
            }

            var streamNames = this.streamList.getStreamIDList();
            var list = [];
            var templist = [];

            for (var index = 0; index < streamNames.length; index++) {
                var regex = new RegExp("[^a-zA-Z]" + streamNames[index] + "[^a-zA-Z0-9]");

                if (fromPhrase[1].match(regex)) {
                    templist = templist.concat(this.streamList.getAttributeList(streamNames[index]));
                }
            }

            streamNames = streamNames.map(function (d) {
                return d + ".";
            });

            var namespaces = getExtensionNamesSpaces(FUNCTIONS);
            namespaces = namespaces.map(function (d) {
                return d + ":"
            });

            var sysFunctions = getSystemFunctionNames();
            sysFunctions = sysFunctions.map(function (d) {
                return d + "(args)"
            });

            list = list.concat(makeCompletions(keywords, 2));
            list = list.concat(makeCompletions(namespaces, 3));
            list = list.concat(makeCompletions(sysFunctions, 1));
            list = list.concat(makeCompletions(streamNames, 4));
            list = list.concat(makeCompletions(templist, 5));

            return list;
        };
        self.$filterPhrase = function (args) {
            var keyword = logicalOperatorList;
            var fromRegxp = /from((?:.(?!from))+)$/i;
            var result = fromRegxp.exec(args[0]);

            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$filterPhrase" + "->");
                console.log("result:", result);
            }
            var start = -1;
            var temp = "";
            var flag = true;

            this.eventStore = {};
            this.$eventReference(result[0]);
            for (var i = result[0].length - 1; i >= 0; i--) {
                if (start == 0) {
                    if (/\W/.test(result[0].charAt(i))) {
                        if (flag)
                            continue;
                        else
                            break;
                    } else {
                        flag = false;
                        temp = result[0].charAt(i) + temp;
                    }
                }

                if (result[0].charAt(i) == ']') {
                    start--;
                }
                if (result[0].charAt(i) == '[') {
                    start++;
                }
            }

            var temparray = [];
            temparray = temparray.concat(makeCompletions(keyword, 1));
            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$filterPhrase" + "->");
                console.log("Event LIST ", temp);
            }

            if (this.eventStore.hasOwnProperty(temp)) {
                temparray = ["last"];
                temparray = makeCompletions(temparray, 2)
            } else {
                var refList = getEventReferences();
                refList = makeCompletions(refList, 2);

                var attrList = this.streamList.getAttributeList(temp);
                attrList = makeCompletions(attrList, 3);
                temparray = temparray.concat(refList);
                temparray = temparray.concat(attrList);
            }

            return temparray;
        };
        self.$nameSpacePhrase = function (args) {
            var result = args[1].exec(args[0]);
            var windowRegex = /#window.(\w+):$/i;
            var streamRegex = /#(\w+):$/i;
            var functionRegex = /(\w+):$/i;
            var tempArray = [];
            var ns = "";
            if (windowRegex.test(result[0])) {
                var windowResult = windowRegex.exec(result[0]);
                ns = windowResult[1];
                tempArray = getExtensionWindowProcessors(ns);
            } else if (streamRegex.test(result[0])) {
                var streamFunctionPhrase = streamRegex.exec(result[0]);
                ns = streamFunctionPhrase[1];
                tempArray = getExtensionStreamProcessors(ns);

            } else if (functionRegex.test(result[0])) {
                var functionPhrase = functionRegex.exec(result[0]);
                ns = functionPhrase[1];
                tempArray = getExtensionFunctionNames(ns);
            } else {

            }

            tempArray = tempArray.map(function (d) {
                return d + "(argList)"
            });
            return makeCompletions(tempArray);

        };
        self.$resolveVariable = function (args) {
            var result = args[1].exec(args[0]);
            var tempList = [];
            if (SiddhiEditor.debug) {
                console.warn(loggerContext + ":" + "$resolveVariable" + "->");
                console.log("result ", result);
            }

            this.$eventReference(args[0]);
            this.$streamAlias(args[0]);

            if (this.tableList.hasTable(result[1])) {
                tempList = this.tableList.getAttributeList(result[1]);
            } else {
                if (this.eventStore.hasOwnProperty(result[1]))
                    result[1] = this.eventStore[result[1]];

                if (this.streamAliasList.hasOwnProperty(result[1]))
                    result[1] = this.streamAliasList[result[1]];

                if (this.streamList.hasStream(result[1]))
                    tempList = this.streamList.getAttributeList(result[1])
            }
            return makeCompletions(tempList, 1);
        };
        self.$streamAlias = function (str) {
            var fromRegxp = /from((?:.(?!from))+)$/i;
            var fromPhrase = fromRegxp.exec(str);
            var asRegexp = /\s+as\s+(\w+)\s+/;
            var tokenArray = fromPhrase[1].split(asRegexp);
            var streamIdList = this.streamList.getStreamIDList();

            var Alias = {};
            if (tokenArray.length >= 2) {
                for (var i = 0; i + 1 < tokenArray.length; i += 2) {
                    var maxIndex = 0;
                    var strId = "";
                    for (var j = 0; j < streamIdList.length; j++) {
                        var tempIndex = 0;
                        if (tempIndex = tokenArray[i].lastIndexOf(streamIdList[j]) >= 0) {
                            if (tempIndex > maxIndex)
                                strId = streamIdList[j];
                        }
                    }

                    Alias[tokenArray[i + 1]] = strId;
                    this.streamAliasList[tokenArray[i + 1]] = strId;
                }
            }

            return Alias;
        };
        self.$eventReferenceHandler = function (args) {
            var results = args[1].exec(args[0]);

            this.$eventReference(args[0]);
            this.$streamAlias(args[0]);
            var ref = this.eventStore[results[1]];
            var tempList = this.streamList.getAttributeList(ref);
            return makeCompletions(tempList);

        };
        self.$eventReference = function (str) {
            var fromRegxp = /from((?:.(?!from))+)$/i;
            var fromPhrase = fromRegxp.exec(str);
            var eventRef = /(\w+\s*=\s*\w+)/;
            var tokenArray = fromPhrase[1].split(eventRef);

            for (var i = 0; i < tokenArray.length; i++) {
                var strId = "";
                if (tokenArray[i].indexOf('=') > 0 && tokenArray[i].indexOf('==') < 0 && tokenArray[i].indexOf('<=') < 0 && tokenArray[i].indexOf('>=') < 0) {
                    var keyValue = tokenArray[i].split("=");
                    if (SiddhiEditor.debug) {
                        console.warn(loggerContext + ":" + "$eventReference" + "->");
                        console.log("keyvalue", keyValue);
                    }

                    var keyRegex = /(\w+)\s*$/i;
                    var valueRegex = /^\s*(\w+)/i;
                    var ref = keyRegex.exec(keyValue[0]);
                    var value = valueRegex.exec(keyValue[1]);

                    if (ref && value && ref[0] && value[0]) {
                        value = value[0].trim();
                        ref = ref[0].trim();

                        //Check the match with stream ID
                        // for (var j = 0; j < streamIdList.length; j++) {
                        //    var tempIndex = 0;
                        //    if (tempIndex = tokenArray[i].lastIndexOf(streamIdList[j]) >= 0) {
                        //        if (tempIndex > maxIndex)
                        //            strId = streamIdList[j];
                        //    }
                        //}

                        this.eventStore[ref] = value;
                    }
                }
            }

        };

        /**
         * Get the current stream alias list
         *
         * @returns {Array}
         */
        function getStreamAliasList() {
            var aliasList = [];
            for (var propertyName in this.streamAliasList) {
                if (this.streamAliasList.hasOwnProperty(propertyName))
                    aliasList.push(propertyName)
            }
            return aliasList;
        }

        /**
         * Get the current event references list
         * @returns {Array}
         */
        function getEventReferences() {
            var aliasList = [];
            for (var propertyName in this.eventStore) {
                if (this.eventStore.hasOwnProperty(propertyName))
                    aliasList.push(propertyName)
            }
            return aliasList;
        }

        /**
         * Get the list of namespaces which has artifacts in  objeType1 or objTyepe2 categories
         *
         * @param {string} objType1 : windowProcessors|functions|streamProcessors
         * @param {string} objType2 : windowProcessors|functions|streamProcessors
         * @returns {Array} : list of namespaces.
         */
        function getExtensionNamesSpaces(objType1, objType2) {
            var tempList = [];

            for (var propertyName in this.extensions) {
                if (this.extensions.hasOwnProperty(propertyName)) {
                    if (SiddhiEditor.debug) {
                        console.warn(loggerContext + ":" + "getExtensionNamesSpaces" + "->");
                        console.log(this.extensions[propertyName][objType1], objType1, propertyName);
                        console.log("RESULTS", objType1 && !isEmpty(this.extensions[propertyName][objType1]));
                    }

                    if ((objType1 && !isEmpty(this.extensions[propertyName][objType1])) ||
                            (objType2 && !isEmpty(this.extensions[propertyName][objType2]))) {
                        tempList.push(propertyName);
                    } else if (!objType1 && !objType2) {
                        tempList.push(propertyName);
                    }
                }
            }
            return tempList;
        }

        /**
         * Get the list of  extension functions of given namespace
         *
         * @param {string} ns : namespace
         * @returns {Array} : list of function names
         */
        function getExtensionFunctionNames(ns) {
            var tempList = [];
            for (var propertyName in this.extensions[ns].functions) {
                if (this.extensions[ns].functions.hasOwnProperty(propertyName))
                    tempList.push(propertyName);
            }
            return tempList;
        }

        /**
         * Get the list of  extension window processors of given namespace
         *
         * @param {string} ns : namespace
         * @returns {Array} : list of window processor names
         */
        function getExtensionWindowProcessors(ns) {
            var tempList = [];
            for (var propertyName in this.extensions[ns].windowProcessors) {
                if (this.extensions[ns].windowProcessors.hasOwnProperty(propertyName))
                    tempList.push(propertyName);
            }
            return tempList;
        }
    };

    //Constructor of the Stream class is exposed to global scope
    CompletionEngine.Stream = Stream;

    /*************************************************************************************************************************
     *                                          Utility functions Completion-engine module
     *************************************************************************************************************************/

    /**
     * Transform the list of regular strings into list of completion objects with given priority
     *
     * @param {Array}  suggestions :- list of  suggestions
     * @param {int} priority :-priority value for the suggestions in current list
     * @returns {Array|*} : list of completion objects that would be required in getAutoCompleter()
     */
    function makeCompletions(suggestions, priority) {
        if (isNaN(priority))
            priority = 1;

        return suggestions.map(function (d) {
            return {word: d, score: priority}
        })
    }

    /**
     * This function will call a given function by it's name within given context
     *
     * @param {string} functionName : name of the function
     * @param {string} context : object refer to 'this' variable
     * @param {Array} args :   arguments array that would be passed to the function
     * @returns {*}
     */
    function executeFunctionByName(functionName, args) {
        return this[functionName].call(this, args);
    }

    /**
     * Check whether a given object has properties or not
     *
     * @param {object} map : object
     * @returns {boolean} : true if the object has properties. false if the object is empty
     */
    function isEmpty(map) {
        for (var key in map) {
            if (map.hasOwnProperty(key)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get the list of  extension stream processors of given namespace
     *
     * @param {string} ns : namespace
     * @returns {Array} : list of stream processor names
     */
    function getExtensionStreamProcessors(ns) {
        var tempList = [];
        for (var propertyName in this.extensions[ns].streamProcessors) {
            if (this.extensions[ns].streamProcessors.hasOwnProperty(propertyName))
                tempList.push(propertyName);
        }
        return tempList;
    }

    /**
     * Get the list of inbuilt function names
     * @returns {Array} : list of function names
     */
    function getSystemFunctionNames() {
        var tempList = [];
        for (var propertyName in this.system.functions) {
            if (this.system.functions.hasOwnProperty(propertyName))
                tempList.push(propertyName);
        }
        return tempList;
    }


    /*************************************************************************************************************************
     *                                          Classes  and constructors
     *************************************************************************************************************************/

    //Stream class represent the abstraction of Stream
    function Stream() {
        this.id = "";
        this.attributeNames = [];
        this.attributeTypes = [];

    }

    Stream.prototype.setStreamFromDefineStatement = function (ctx) {
        this.id = ctx.source().start.text;
        var counter = 0;
        while (attrName = ctx.attribute_name(counter)) {
            this.attributeNames.push(ctx.attribute_name(counter).start.text);
            this.attributeTypes.push(ctx.attribute_type(counter).start.text);
            counter++;
        }
        this.cacheContext = ctx;
    };
    Stream.prototype.getAttributeNameList = function () {
        return this.attributeNames;
    };
    Stream.prototype.getAttribute = function (i) {
        return this.attributeNames[i];
    };


    //StreamList Class represents the symbolic list for streams within the execution plan
    function StreamList() {
        this.streamList = {};
    }

    StreamList.prototype.addStream = function (streamObj) {
        this.streamList[streamObj.id] = streamObj;
    };
    StreamList.prototype.getAttributeList = function (id) {
        if (!this.streamList[id])
            return [];
        return this.streamList[id].getAttributeNameList();
    };
    StreamList.prototype.clear = function () {
        this.streamList = {};
        //var array=this.getStreamIDList();
        //for(var i=0;i<array.length;i++)
        //{
        //    delete this.editor.completionEngine.streamList[array[i]];
        //}
    };
    StreamList.prototype.getStreamIDList = function () {
        var temp = [];
        for (var propertyName in this.streamList) {
            // propertyName is what you want
            // you can get the value like this: myObject[propertyName]
            if (this.streamList.hasOwnProperty(propertyName))
                temp.push(propertyName);
        }

        return temp;
    };
    StreamList.prototype.hasStream = function (id) {
        var status = false;
        this.getStreamIDList().map(function (d) {
            if (id == d)
                status = true;
        });
        return status;
    };


    //Table class represents Stream Table
    function Table() {
        this.id = "";
        this.attributeNames = [];
        this.attributeTypes = [];

    }

    Table.prototype.setTableFromDefineStatement = function (ctx) {
        this.id = ctx.source().start.text;
        var counter = 0;
        while (attrName = ctx.attribute_name(counter)) {
            this.attributeNames.push(ctx.attribute_name(counter).start.text);
            this.attributeTypes.push(ctx.attribute_type(counter).start.text);
            counter++;
        }
        this.cacheContext = ctx;
    };
    Table.prototype.getAttributeNameList = function () {
        return this.attributeNames;
    };
    Table.prototype.getAttribute = function (i) {
        return this.attributeNames[i];
    };


    Table.prototype.setTableFromDefineStatement = function (ctx) {
        this.id = ctx.source().start.text;
        var counter = 0;
        var attrName;

        while (attrName = ctx.attribute_name(counter)) {
            this.attributeNames.push(ctx.attribute_name(counter).start.text);
            this.attributeTypes.push(ctx.attribute_type(counter).start.text);
            counter++;
        }
        this.cacheContext = ctx;
    };
    Table.prototype.getAttributeNameList = function () {
        return this.attributeNames;
    };
    Table.prototype.getAttribute = function (i) {
        return this.attributeNames[i];
    };

    //TableList class represent the symbolic list of Stream tables
    function TableList() {
        this.tableList = {};
    }

    TableList.prototype.addTable = function (tableObj) {
        this.tableList[tableObj.id] = tableObj;
    };
    TableList.prototype.getAttributeList = function (id) {
        return this.tableList[id].getAttributeNameList();
    };
    TableList.prototype.getTableIDList = function () {
        var temp = [];
        for (var propertyName in this.tableList) {
            if (this.tableList.hasOwnProperty(propertyName))
                temp.push(propertyName);
        }
        return temp;
    };
    TableList.prototype.hasTable = function (id) {
        var status = false;
        this.getTableIDList().map(function (d) {
            if (id == d)
                status = true;
        });
        return status;
    };


    //Function class which represent the functions defined within the execution plan
    function Function() {
        this.id = "";
        this.lang = "";
        this.returnType = "";
        this.code = "";
    }

    //FunctionList
    function FunctionList() {
        this.functionList = {};
    }
    FunctionList.prototype.addFunction = function (functionObj) {
        this.functionList[functionObj.id] = functionObj;
    };
    FunctionList.prototype.getFunctionIDList = function () {
        var temp = [];
        for (var propertyName in this.functionList) {
            temp.push(propertyName);
        }
        return temp;
    };

})();