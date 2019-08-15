/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// tslint:disable:no-suspicious-comment max-line-length // TODO:

import * as fse from 'fs-extra';
import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
import { callWithTelemetryAndErrorHandling, callWithTelemetryAndErrorHandlingSync, IActionContext, parseError } from 'vscode-azureextensionui';
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, Trace } from 'vscode-languageclient';
import { dotnetAcquire, ensureDotnetDependencies } from '../acquisition/dotnetAcquisition';
import { armDeploymentLanguageId } from '../constants';
import { ext } from '../extensionVariables';
import { armDeploymentDocumentSelector } from '../supported';
import { WrappedErrorHandler } from './WrappedErrorHandler';

const languageServerName = 'ARM Language Server';
const languageServerFolderName = 'languageServer';
const languageServerDllName = 'Microsoft.ArmLanguageServer.dll';
export let serverStartMs: number;
const defaultTraceLevel = 'Warning';
const dotnetVersion = '2.2';

let client: LanguageClient;

export async function stopArmLanguageServer(): Promise<void> {
    ext.outputChannel.appendLine("Stopping ARM language server...");
    if (client) {
        await client.stop();
        client = undefined;
    }

    ext.outputChannel.appendLine("... language server stopped");
}

// tslint:disable-next-line:max-func-body-length //asdf
export async function startArmLanguageServer(context: ExtensionContext): Promise<void> {
    let languageServerDllPath: string = findLanguageServer(context);
    let dotnetExePath: string = await acquireDotnet(languageServerDllPath);
    await ensureDependencies(dotnetExePath, languageServerDllPath);

    await callWithTelemetryAndErrorHandling('startArmLanguageClient', async () => {
        try {

            // The server is implemented in .NET Core. We run it by calling 'dotnet' with the dll as an argument

            // These trace levels are available in the server:
            //   Trace
            //   Debug
            //   Information
            //   Warning
            //   Error
            //   Critical
            //   None
            let trace: string = workspace.getConfiguration('armTools').get<string>("languageServer.traceLevel") || defaultTraceLevel;

            let commonArgs = [
                languageServerDllPath,
                '--logLevel',
                trace
            ];

            if (workspace.getConfiguration('armTools').get<boolean>('languageServer.waitForDebugger', false) === true) {
                commonArgs.push('--wait-for-debugger');
            }
            if (ext.addCompletionDiagnostic) {
                // Forces the server to add a completion message to its diagnostics
                commonArgs.push('--verbose-diagnostics');
            }

            // If the extension is launched in debug mode then the debug server options are used
            // Otherwise the run options are used
            let serverOptions: ServerOptions = {
                run: { command: dotnetExePath, args: commonArgs, options: { shell: false } },
                debug: { command: dotnetExePath, args: commonArgs, options: { shell: false } },
            };

            // Options to control the language client
            let clientOptions: LanguageClientOptions = {
                documentSelector: armDeploymentDocumentSelector,
                // synchronize: { asdf
                //     // Synchronize the setting section 'languageServerExample' to the server
                //     // TODO: configurationSection: 'languageServerExampleTODO',
                //     fileEvents: workspace.createFileSystemWatcher('**/*.json')
                // },
                //asdf initializationFailedHandler
                diagnosticCollectionName: "ARM Language Server diagnostics",
                revealOutputChannelOn: RevealOutputChannelOn.Error,

            };

            // Create the language client and start the client.
            ext.outputChannel.appendLine(`Starting ARM Language Server at ${languageServerDllPath}`);
            ext.outputChannel.appendLine(`Client options:\n${JSON.stringify(clientOptions, null, 2)}`);
            ext.outputChannel.appendLine(`Server options:\n${JSON.stringify(serverOptions, null, 2)}`);
            client = new LanguageClient(armDeploymentLanguageId, languageServerName, serverOptions, clientOptions);

            client.onDidChangeState(e => {
                ext.outputChannel.appendLine(`State changed from ${e.oldState} to ${e.newState}`); //asdf
            });
            client.onReady().then(() => {
                ext.outputChannel.appendLine("onReady()");
            });
            client.onTelemetry(e => {
                ext.outputChannel.appendLine("onTelementry");
                ext.outputChannel.appendLine(String(e));
            });

            let defaultHandler = client.createDefaultErrorHandler();
            client.clientOptions.errorHandler = new WrappedErrorHandler(defaultHandler);

            serverStartMs = Date.now();
            let disposable = client.start();
            // Push the disposable to the context's subscriptions so that the
            // client can be deactivated on extension deactivation
            context.subscriptions.push(disposable);

            await client.onReady();

            client.onNotification("textDocument/hover", e => {
                ext.outputChannel.appendLine(String(<object>e)); //asdf
            });
            client.onRequest("textDocument/hover", e => {
                ext.outputChannel.appendLine(String(<object>e)); //asdf
            });

            client.sendNotification("my custom method");
            client.info("Here is some info");
            client.error("This is an error");
            client.warn("Here is a warning");
            client.trace = Trace.Verbose; //asdf
            client.info("Here is some info");
            client.error("This is an error");
            client.warn("Here is a warning");

        } catch (error) {
            throw new Error(
                // tslint:disable-next-line: prefer-template
                `${languageServerName}: An error occurred starting the language server.\n\n` +
                parseError(error).message);
        }
    });
}

async function acquireDotnet(dotnetExePath: string): Promise<string> {
    return await callWithTelemetryAndErrorHandling('acquireDotnet', async (actionContext: IActionContext) => {
        dotnetExePath = await dotnetAcquire(dotnetVersion);
        if (!(await fse.pathExists(dotnetExePath)) || !(await fse.stat(dotnetExePath)).isFile) {
            throw new Error(`Unexpected path returned for .net core: ${dotnetExePath}`);
        }
        ext.outputChannel.appendLine(`Dotnet core path: ${dotnetExePath}`);

        // Telemetry: dotnet version actually used
        try {
            // E.g. "c:\Users\<user>\AppData\Roaming\Code - Insiders\User\globalStorage\msazurermtools.azurerm-vscode-tools\.dotnet\2.2.5\dotnet.exe"
            let actualVersion = dotnetExePath.match(/dotnet[\\/]([^\\/]+)[\\/]/)[1];
            actionContext.telemetry.properties.dotnetVersionInstalled = actualVersion;
        } catch (error) {
            // ignore (telemetry only)
        }

        return dotnetExePath;
    });
}

function findLanguageServer(context: ExtensionContext): string {
    let serverDllPath: string;

    return callWithTelemetryAndErrorHandlingSync('findLanguageServer', (actionContext: IActionContext) => {
        let serverDllPathSetting: string | undefined = workspace.getConfiguration('armTools').get<string | undefined>('languageServer.path');
        if (typeof serverDllPathSetting !== 'string' || serverDllPathSetting === '') {
            // armTools.languageServer.path not set - look for the files in their normal installed location under languageServerFolderName
            let serverFolderPath = context.asAbsolutePath(languageServerFolderName);
            serverDllPath = path.join(serverFolderPath, languageServerDllName);
            if (!fse.existsSync(serverFolderPath) || !fse.existsSync(serverDllPath)) {
                throw new Error(`Couldn't find the ARM language server at ${serverDllPath}, you may need to reinstall the extension.`);
            }
            serverDllPath = path.join(serverFolderPath, languageServerDllName);
        } else {
            serverDllPath = serverDllPathSetting;
            actionContext.telemetry.properties.isCustomLanguageServerPath = 'true';
            if (fse.statSync(serverDllPathSetting).isDirectory()) {
                serverDllPath = path.join(serverDllPathSetting, languageServerDllName);
            }
            if (!fse.existsSync(serverDllPath)) {
                throw new Error(`Couldn't find the ARM language server at ${serverDllPath}.  Please verify or remove your 'armTools.languageServer.path' setting.`);
            }
        }

        return serverDllPath;
    });
}

async function ensureDependencies(dotnetExePath: string, serverDllPath: string): Promise<void> {
    await callWithTelemetryAndErrorHandling('ensureDotnetDependencies', async (actionContext: IActionContext) => {
        // Attempt to determine by running a .net app whether additional runtime dependencies are missing on the machine (Linux only),
        // and if necessary prompts the user whether to install them.
        await ensureDotnetDependencies(
            dotnetExePath,
            [
                serverDllPath,
                '--help'
            ],
            actionContext.telemetry.properties);
    });
}