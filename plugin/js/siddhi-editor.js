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

"use strict";   // JS strict mode

/**
 *  This Script contains the integration code segment of Siddhi editor.
 *  This will set the options of ACE editor, attach client side parser and attach SiddhiCompletion Engine with the editor
 **/
(function () {
    var SiddhiEditor = window.SiddhiEditor || {};
    window.SiddhiEditor = SiddhiEditor;
    var constants = SiddhiEditor.constants || {};
    SiddhiEditor.constants = constants;

    var TokenTooltip = ace.require(constants.ace.TOKEN_TOOLTIP).TokenTooltip;        // Required for token tooltips
    var langTools = ace.require(constants.ace.LANG_TOOLS);                                       // Required for auto completion

    /*
     * Map for completion list styles
     * Update this map to update the styles applied to the completion list popup items
     */
    var completionTypeToStyleMap = {};
    completionTypeToStyleMap[constants.SNIPPETS] = "font-style: italic;";

    /*
     * Generating the displayNameToStyleMap from completionTypeToStyleMap
     * This is done to support defining completion popup styles using the completion type name rather than the display name
     */
    var displayNameToStyleMap = {};
    for (var completionType in completionTypeToStyleMap) {
        if (completionTypeToStyleMap.hasOwnProperty(completionType)) {
            displayNameToStyleMap[constants.typeToDisplayNameMap[completionType]] =
                completionTypeToStyleMap[completionType];
        }
    }

    /*
     * Loading meta data for the completion engine from the server
     */
    SiddhiEditor.CompletionEngine.loadMetaData();

    /**
     * Siddhi Editor prototype constructor
     *
     * @constructor
     * @param {Object} config The configuration object to be used in the initialization
     */
    SiddhiEditor.init = function(config) {
        var self = this;
        var aceEditor = ace.edit(config.divID);                // Setting the DivID of the Editor .. Could be <pre> or <div> tags

        self.realTimeValidation = config.realTimeValidation;
        new TokenTooltip(aceEditor);
        aceEditor.setReadOnly(config.readOnly);

        // Setting the editor options
        aceEditor.session.setMode(constants.ace.SIDDHI_MODE);   // Language mode located at ace-editor/mode-siddhi.js
        aceEditor.setTheme(config.theme ? "ace/theme/" + config.theme : constants.ace.DEFAULT_THEME);
        aceEditor.getSession().setUseWrapMode(true);
        aceEditor.getSession().setTabSize(4);
        aceEditor.getSession().setUseSoftTabs(true);
        aceEditor.setShowFoldWidgets(true);
        aceEditor.setBehavioursEnabled(true);
        aceEditor.setHighlightSelectedWord(true);
        aceEditor.setHighlightActiveLine(true);
        aceEditor.setDisplayIndentGuides(true);
        aceEditor.setShowPrintMargin(false);
        aceEditor.setShowFoldWidgets(true);
        aceEditor.session.setFoldStyle("markbeginend");
        aceEditor.setFontSize(14);
        aceEditor.setOptions({
            enableBasicAutocompletion: !config.readOnly && config.autoCompletion,
            enableSnippets: !config.readOnly && config.autoCompletion,
            enableLiveAutocompletion: config.autoCompletion,
            autoScrollEditorIntoView: true,
            enableMultiselect: false
        });

        // Adding the default text into the editor
        aceEditor.setValue("/* Enter a unique ExecutionPlan */\n" +
            "@Plan:name('ExecutionPlan')\n\n" +
            "/* Enter a unique description for ExecutionPlan */\n" +
            "-- @Plan:description('ExecutionPlan')\n\n" +
            "/* define streams/tables and write queries here ... */\n\n", 1);
        aceEditor.focus();

        // State variables for error checking and highlighting
        self.state = {};
        self.state.syntaxErrorList = [];        // To save the syntax Errors with line numbers
        self.state.semanticErrorList = [];      // To save semanticErrors with line numbers
        self.state.lastEdit = 0;                // Last edit time

        self.completionEngine = new SiddhiEditor.CompletionEngine();

        // Attaching editor's onChange event handler
        aceEditor.getSession().on('change', editorChangeHandler);

        // For adjusting the completer list as required
        adjustAutoCompletionHandlers();
        aceEditor.commands.on('afterExec', function () {
            adjustAutoCompletionHandlers();
        });

        // Adding events for adjusting the completions list styles
        aceEditor.renderer.on("afterRender", function () {
            // Checking if a popup is open when the editor is re-rendered
            if (aceEditor.completer && aceEditor.completer.popup) {
                // Adding a on after render event for updating the popup styles
                aceEditor.completer.popup.renderer.on("afterRender", function () {
                    var completionElements = document.querySelectorAll(
                        ".ace_autocomplete > .ace_scroller > .ace_content > .ace_text-layer > .ace_line"
                    );
                    for (var i = 0; i < completionElements.length; i++) {
                        var element = completionElements[i].getElementsByClassName("ace_rightAlignedText")[0];
                        if (element && displayNameToStyleMap[element.innerHTML]) {
                            completionElements[i].setAttribute(
                                "style",
                                displayNameToStyleMap[element.innerHTML]
                            );
                        }
                    }
                });
            }
        });

        var siddhiWorker = new SiddhiWorker(new MessageHandler(self));

        /**
         * Returns the ace editor object
         * Can be used for getting the ace editor object and making custom changes
         */
        self.getAceEditorObject = function () {
            return aceEditor;
        };

        /**
         * Returns the content in the ace editor when the method is invoked
         *
         * @return {string} Content in the editor when the method is invoked
         */
        self.getContent = function () {
            return aceEditor.getValue();
        };

        /**
         * Sets the content in the ace editor
         *
         * @param content Content to set into the ace editor
         */
        self.setContent = function (content) {
            aceEditor.setValue(content, 1);
        };

        /**
         * Dynamically select the completers suitable for current context
         *
         * @private
         */
        function adjustAutoCompletionHandlers() {
            // This method will dynamically select the appropriate completer for current context when auto complete event occurred.
            // SiddhiCompleter needs to be the first completer in the list as it will update the snippets
            var completerList = [self.completionEngine.SiddhiCompleter, self.completionEngine.SnippetCompleter];

            // Adding keyword completor if the cursor is not in front of dot or colon
            var objectNameRegex = new RegExp("[a-zA-Z_][a-zA-Z_0-9]*\\s*\\.\\s*$", "i");
            var namespaceRegex = new RegExp("[a-zA-Z_][a-zA-Z_0-9]*\\s*:\\s*$", "i");
            var singleLineCommentRegex = new RegExp("--(?:.(?!\n))*$");
            var blockCommentRegex = new RegExp("\\/\\*(?:(?:.|\n)(?!\\*\\/))*$");
            var editorText = aceEditor.getValue();
            if (!(objectNameRegex.test(editorText) || namespaceRegex.test(editorText) ||
                singleLineCommentRegex.test(editorText) || blockCommentRegex.test(editorText))) {
                completerList.push(langTools.keyWordCompleter);
            }

            aceEditor.completers = completerList;
        }

        /**
         * Editor change handler
         *
         * @private
         */
        function editorChangeHandler() {
            self.completionEngine.clearData();                  // Clear the exiting completion engine data

            // Clearing all errors before finding the errors again
            self.state.semanticErrorList = [];
            self.state.syntaxErrorList = [];

            var editorText = aceEditor.getValue().trim();          // Input text

            siddhiWorker.onEditorChange(editorText);

            // if (parser._syntaxErrors == 0 && config.realTimeValidation && self.state.previousParserTree &&
            //     self.state.previousParserTree.toStringTree(tree, parser) != tree.toStringTree(tree, parser)) {
            //     // If there are no syntax errors and there is a change in parserTree
            //     // check for semantic errors if there is no change in the query within 3sec period
            //     // 3 seconds delay is added to avoid repeated server calls while user is typing the query.
            //     setTimeout(function () {
            //         if (Date.now() - self.state.lastEdit >= SiddhiEditor.serverSideValidationDelay - 100) {
            //             // Updating the token tooltips using the data available
            //             // Some data that was intended to be fetched from the server might be missing
            //             updateTokenToolTips(tree);
            //
            //             // Check for semantic errors by sending a validate request to the server
            //             checkForSemanticErrors();
            //         }
            //     }, SiddhiEditor.serverSideValidationDelay);
            // }
            //
            // self.state.previousParserTree = tree;     // Save the current parser tree
            // self.state.lastEdit = Date.now();         // Save user's last edit time
        }

        /**
         * This method send server calls to check the semantic errors
         * Also retrieves the missing completion engine data from the server if the execution plan is valid
         *
         * @private
         */
        function checkForSemanticErrors() {
            var foundSemanticErrors = false;

            var editorText = aceEditor.getValue();
            // If the user has not typed anything after 3 seconds from his last change, then send the query for semantic check
            // check whether the query contains errors or not
            submitToServerForSemanticErrorCheck(
                {
                    executionPlan: editorText,
                    missingStreams: self.completionEngine.incompleteData.streams
                },
                function (response) {
                    if (response.status == "SUCCESS") {
                        /*
                         * Execution plan is valid
                         */
                        // Populating the fetched data for incomplete data items into the completion engine's data
                        for (var stream in response.streams) {
                            if (response.streams.hasOwnProperty(stream)) {
                                var streamDefinition = response.streams[stream];
                                var attributes = {};
                                for (var k = 0; k < streamDefinition.attributeList.length; k++) {
                                    attributes[streamDefinition.attributeList[k].name] =
                                        streamDefinition.attributeList[k].type;
                                }
                                self.completionEngine.streamsList[stream] = {
                                    attributes: attributes,
                                    description: SiddhiEditor.utils.generateDescriptionForStreamOrTable("Stream", stream, attributes)
                                };
                            }
                        }

                        // Updating token tooltips
                        self.completionEngine.clearIncompleteDataLists();
                        updateTokenToolTips(self.state.previousParserTree);
                    } else {
                        /*
                         * Error found in execution plan
                         */

                        /*
                         * Send the query appending one statement after each request to identify the statement in which the error is at
                         * This is required since the siddhi engine desnt return the line number
                         */
                        var query = "";
                        for (var i = 0; i < self.completionEngine.statementsList.length; i++) {
                            if (self.completionEngine.statementsList[i].statement.substring(0, 2) != "\\*" &&
                                self.completionEngine.statementsList[i].statement.substring(0, 2) != "--") {  // Appending statements excepts comments
                                query += self.completionEngine.statementsList[i].statement + "  \n";
                                (function (line, query) {
                                    submitToServerForSemanticErrorCheck({
                                        executionPlan: query,
                                        missingStreams: []
                                    }, function (response) {
                                        if (!foundSemanticErrors && response.status != "SUCCESS" &&
                                            Date.now() - self.state.lastEdit >= SiddhiEditor.serverSideValidationDelay - 100) {
                                            // Update the semanticErrorList
                                            self.state.semanticErrorList.push({
                                                row: line,
                                                // Change attribute "text" to "html" if html is sent from server
                                                text: SiddhiEditor.utils.wordWrap(response.message, 100),
                                                type: "error"
                                            });

                                            // Update the state of the foundSemanticErrors to stop sending another server call
                                            foundSemanticErrors = true;

                                            // Show the errors
                                            aceEditor.session.setAnnotations(
                                                self.state.semanticErrorList.concat(self.state.syntaxErrorList)
                                            );
                                        }
                                    });
                                })(self.completionEngine.statementsList[i].line, query);

                                if (foundSemanticErrors ||
                                    Date.now() - self.state.lastEdit < SiddhiEditor.serverSideValidationDelay - 100) {
                                    break;
                                }
                            }
                        }
                    }
                }
            );
        }

        /**
         * Update the token tool tips
         *
         * @private
         */
        function updateTokenToolTips(parseTree) {
            var parserListener = new TokenToolTipUpdateListener(self);
            antlr4.tree.ParseTreeWalker.DEFAULT.walk(parserListener, parseTree);
        }

        /**
         * Submit the execution plan to server for semantic error checking
         * Also fetched the incomplete data from the server for the completion engine
         *
         * @private
         * @param {Object} data The execution plan and the missing data in a java script object
         * @param {function} callback Missing streams whose definitions should be fetched after validation
         */
        function submitToServerForSemanticErrorCheck(data, callback) {
            if (data.executionPlan == "") {
                return;
            }
            jQuery.ajax({
                type: "POST",
                url: SiddhiEditor.serverURL + "siddhi-editor/validate",
                data: JSON.stringify(data),
                success: callback
            });
        }

        return self;
    };

    function SiddhiWorker(messageHandler) {
        var self = this;
        var worker;

        self.restart = function () {
            if (worker) {
                worker.terminate();
            }
            worker = new Worker(SiddhiEditor.baseURL + "js/antlr-worker.js");
            self.init();
        };

        self.init = function() {
            worker.postMessage(JSON.stringify({
                type: constants.worker.INIT,
                data: {
                    antlr: constants.antlr,
                    worker: constants.worker
                }
            }));

            worker.addEventListener('message', function (event) {
                messageHandler.handle(JSON.parse(event.data));
            });
        };

        self.onEditorChange = function (editorText) {
            worker.postMessage(JSON.stringify({
                type: constants.worker.EDITOR_CHANGE_EVENT,
                data: editorText
            }));
        };

        self.generateTokenTooltips = function () {
            worker.postMessage(JSON.stringify({
                type: constants.worker.GENERATE_TOKEN_TOOLTIP
            }));
        };

        self.restart();
        return self;
    }

    function MessageHandler(editor) {
        var handler = {};
        var messageHandlerMap = {};

        messageHandlerMap[constants.worker.PARSE_TREE_WALKING_COMPLETION] = updateSyntaxErrorList;
        messageHandlerMap[constants.worker.DATA_POPULATION_COMPLETION] = updateCompletionEngineData;

        handler.handle = function (message) {
            messageHandlerMap[message.type](message.data);
        };

        function updateSyntaxErrorList (data) {
            editor.state.syntaxErrorList = data;
        }

        function updateCompletionEngineData (data) {
            editor.completionEngine.streamsList = data.completionData.streamsList;
            editor.completionEngine.eventTablesList = data.completionData.eventTablesList;
            editor.completionEngine.eventTriggersList = data.completionData.eventTriggersList;
            editor.completionEngine.evalScriptsList = data.completionData.evalScriptsList;
            editor.completionEngine.eventWindowsList = data.completionData.eventWindowsList;
            editor.completionEngine.incompleteData = data.incompleteData;
            editor.completionEngine.statementsList = data.statementsList;
        }

        return handler;
    }
})();
