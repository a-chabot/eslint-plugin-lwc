/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
'use strict';
const { analyze } = require('./analyze-component');
const { isSSREscape } = require('./util/ssr');
const { isGlobalIdentifier } = require('./util/scope');

/**
 * Visitors for detecting methods/functions that are reacheable during SSR
 * @param {import('eslint').Rule.RuleContext} context
 */
function reachableDuringSSRPartial() {
    let moduleInfo;
    let insideLWC = false;
    let reachableFunctionThatWeAreIn = null;
    let reachableMethodThatWeAreIn = null;
    let skippedBlockThatWeAreIn = null;

    const withinLWCVisitors = {
        Program: (node) => {
            moduleInfo = analyze(node);
        },
        ClassDeclaration: (node) => {
            if (node === moduleInfo.lwcClassDeclaration) {
                insideLWC = true;
            }
        },
        'ClassDeclaration:exit': (node) => {
            if (node === moduleInfo.lwcClassDeclaration) {
                insideLWC = false;
            }
        },
        FunctionDeclaration: (node) => {
            if (
                !reachableFunctionThatWeAreIn &&
                node.id &&
                node.id.type === 'Identifier' &&
                moduleInfo.moduleScopedFunctionsReachableDuringSSR.has(node.id && node.id.name)
            ) {
                reachableFunctionThatWeAreIn = node;
            }
        },
        'FunctionDeclaration:exit': (node) => {
            if (node === reachableFunctionThatWeAreIn) {
                reachableFunctionThatWeAreIn = null;
            }
        },
        FunctionExpression: (node) => {
            if (
                !reachableFunctionThatWeAreIn &&
                node.parent.type === 'VariableDeclarator' &&
                node.parent.id.type === 'Identifier' &&
                moduleInfo.moduleScopedFunctionsReachableDuringSSR.has(node.parent.id.name)
            ) {
                reachableFunctionThatWeAreIn = node;
            }
        },
        'FunctionExpression:exit': (node) => {
            if (node === reachableFunctionThatWeAreIn) {
                reachableFunctionThatWeAreIn = null;
            }
        },
        ArrowFunctionExpression: (node) => {
            if (
                !reachableFunctionThatWeAreIn &&
                node.parent.type === 'VariableDeclarator' &&
                node.parent.id.type === 'Identifier' &&
                moduleInfo.moduleScopedFunctionsReachableDuringSSR.has(node.parent.id.name)
            ) {
                reachableFunctionThatWeAreIn = node;
            }
        },
        'ArrowFunctionExpression:exit': (node) => {
            if (node === reachableFunctionThatWeAreIn) {
                reachableFunctionThatWeAreIn = null;
            }
        },
        MethodDefinition: (node) => {
            if (
                insideLWC &&
                node.key.type === 'Identifier' &&
                moduleInfo.methodsReachableDuringSSR.has(node.key.name)
            ) {
                reachableMethodThatWeAreIn = node;
            }
        },
        'MethodDefinition:exit': () => {
            reachableMethodThatWeAreIn = null;
        },
        IfStatement: (node) => {
            if (isSSREscape(node)) {
                skippedBlockThatWeAreIn = node;
            }
        },
        'IfStatement:exit': (node) => {
            if (skippedBlockThatWeAreIn === node) {
                skippedBlockThatWeAreIn = null;
            }
        },
    };

    return {
        withinLWCVisitors,
        isInsideReachableMethod: () => insideLWC && !!reachableMethodThatWeAreIn,
        isInsideReachableFunction: () => !!reachableFunctionThatWeAreIn,
        isInsideSkippedBlock: () => !!skippedBlockThatWeAreIn,
    };
}

const moduleScopeDisqualifiers = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
]);

function inModuleScope(node, context) {
    for (const ancestor of context.getAncestors()) {
        if (moduleScopeDisqualifiers.has(ancestor.type)) {
            return false;
        }
    }
    return true;
}

module.exports.noReferenceDuringSSR = function noReferenceDuringSSR(
    forbiddenGlobalNames,
    messageIds,
    context,
) {
    const {
        withinLWCVisitors,
        isInsideReachableMethod,
        isInsideReachableFunction,
        isInsideSkippedBlock,
    } = reachableDuringSSRPartial();

    return {
        ...withinLWCVisitors,
        MemberExpression: (node) => {
            if (
                (!isInsideReachableMethod() &&
                    !isInsideReachableFunction() &&
                    !inModuleScope(node, context)) ||
                isInsideSkippedBlock()
            ) {
                return;
            }
            if (
                node.parent.type === 'MemberExpression' &&
                node.object.type === 'Identifier' &&
                node.object.name === 'globalThis' &&
                node.property.type === 'Identifier' &&
                forbiddenGlobalNames.has(node.property.name) &&
                node.parent.optional !== true &&
                isGlobalIdentifier(node.object, context.getScope())
            ) {
                // Prevents expressions like:
                // globalThis.document.addEventListener('click', () => { ... });

                // Allows expressions like:
                // globalThis.document?.addEventListener('click', () => { ... });
                context.report({
                    messageId: messageIds.at(1),
                    node,
                    data: {
                        identifier: node.property.name,
                        property: node.parent.property.name,
                    },
                });
            } else if (
                node.parent.type !== 'MemberExpression' &&
                node.object.type === 'Identifier' &&
                (forbiddenGlobalNames.has(node.object.name) ||
                    (node.object.name === 'globalThis' && node.optional !== true)) &&
                isGlobalIdentifier(node.object, context.getScope())
            ) {
                // Prevents expressions like:
                // globalThis.addEventListener('click', () => { ... });
                // document.addEventListener('click', () => { ... });
                // document?.addEventListener('click', () => { ... });

                // Allows expressions like:
                // globalThis?.addEventListener('click', () => { ... });
                context.report({
                    messageId: messageIds.at(0),
                    node,
                    data: {
                        identifier:
                            node.object.name === 'globalThis'
                                ? node.property.name
                                : node.object.name,
                    },
                });
            }
        },
        Identifier: (node) => {
            if (
                (!isInsideReachableMethod() &&
                    !isInsideReachableFunction() &&
                    !inModuleScope(node, context)) ||
                isInsideSkippedBlock()
            ) {
                return;
            }
            if (
                node.parent.type !== 'MemberExpression' &&
                forbiddenGlobalNames.has(node.name) &&
                isGlobalIdentifier(node, context.getScope())
            ) {
                // Prevents expressions like:
                // doSomethingWith(window);
                // doSomethingWith(document);

                // Allows expressions like:
                // doSomethingWith(globalThis)
                context.report({
                    messageId: messageIds.at(0),
                    node,
                    data: {
                        identifier: node.name,
                    },
                });
            }
        },
    };
};

module.exports.noPropertyAccessDuringSSR = function noPropertyAccessDuringSSR(
    forbiddenPropertyNames,
    reporter,
) {
    const { withinLWCVisitors, isInsideReachableMethod, isInsideSkippedBlock } =
        reachableDuringSSRPartial();

    return {
        ...withinLWCVisitors,
        MemberExpression: (node) => {
            if (!isInsideReachableMethod() || isInsideSkippedBlock()) {
                return;
            }
            if (
                node.object.type === 'ThisExpression' &&
                node.property.type === 'Identifier' &&
                forbiddenPropertyNames.includes(node.property.name)
            ) {
                reporter(node);
            }
        },
    };
};

module.exports.noNodeEnvInSSR = function noNodeEnvInSSR(context) {
    const {
        withinLWCVisitors,
        isInsideReachableFunction,
        isInsideReachableMethod,
        isInsideSkippedBlock,
    } = reachableDuringSSRPartial();

    return {
        ...withinLWCVisitors,
        MemberExpression: (node) => {
            if (
                (!isInsideReachableMethod() &&
                    !isInsideReachableFunction() &&
                    !inModuleScope(node, context)) ||
                isInsideSkippedBlock()
            ) {
                return;
            }
            if (
                node.property.type === 'Identifier' &&
                node.property.name === 'NODE_ENV' &&
                node.object.type === 'MemberExpression' &&
                node.object.object &&
                node.object.object.type === 'Identifier' &&
                node.object.object.name === 'process' &&
                node.object.property.type === 'Identifier' &&
                node.object.property.name === 'env'
            ) {
                context.report({
                    node,
                    messageId: 'nodeEnvFound',
                    data: {
                        identifier: node.property.name,
                    },
                });
            }
        },
    };
};