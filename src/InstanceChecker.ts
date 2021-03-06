import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import {AbstractSubController} from "./AbstractSubController";
import {AbstractExchange, ExchangeMap} from "./Exchanges/AbstractExchange";
import {AbstractStrategy} from "./Strategies/AbstractStrategy";
import {Currency, Trade, Process} from "@ekliptor/bit-models";
import {AbstractNotification} from "./Notifications/AbstractNotification";
import Notification from "./Notifications/Notification";
import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";
const exec = child_process.exec
import * as os from "os";
import * as db from "./database";
import * as helper from "./utils/helper";
import * as argvFunction from "minimist";
const argv = argvFunction(process.argv.slice(2));


export default class InstanceChecker extends AbstractSubController {
    public static readonly INSTANCE_CHECK_INTERVAL_SEC = 300; // must be >= 5min (time the cron will restart crashed bots)

    protected lastCheck: Date = null;
    protected lastPort: number = 0;
    protected lastResponse = new Date(); // assume working on startup
    protected notifier: AbstractNotification;
    protected lastNotification: Date = null;

    constructor() {
        super()
        //this.lastCheck = new Date(); // set checked on start because all bots might just be starting (system startup)
        this.notifier = AbstractNotification.getInstance(true);
    }

    public process() {
        return new Promise<void>((resolve, reject) => {
            if (argv.monitor === true)
                nconf.set('serverConfig:checkInstances', true); // argument overwrites config setting

            if (!nconf.get('serverConfig:checkInstances') || nconf.get('trader') === "Backtester"/*nconf.get('trader') !== "RealTimeTrader"*/ || process.env.IS_CHILD) {
                if (argv.monitor === true)
                    setTimeout(resolve.bind(this), InstanceChecker.INSTANCE_CHECK_INTERVAL_SEC);
                else
                    return resolve();
            }

            this.checkInstances().then(() => {
                resolve()
            }).catch((err) => {
                logger.error("Error checking bot instances", err)
                resolve() // continue
            })
        })
    }

    /**
     * Returns the name of the first directory that matches our project name.
     * @returns {string}
     */
    public static getOwnInstanceName() {
        let dirParts = utils.appDir.split(path.sep);
        let name = "";
        for (let i = dirParts.length-1; i >= 0; i--)
        {
            if (dirParts[i].indexOf(nconf.get("projectName")) !== -1) {
                name = dirParts[i];
                break;
            }
        }
        return name;
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected checkInstances() {
        return new Promise<void>((resolve, reject) => {
            if (this.lastCheck && this.lastCheck.getTime() + InstanceChecker.INSTANCE_CHECK_INTERVAL_SEC * 1000 > Date.now())
                return resolve()

            let name = this.getNextInstanceName()
            this.checkInstanceRunning(name).then(() => {
                this.lastCheck = new Date();
                this.checkLastRespnseTime(name);
                resolve()
            }).catch((err) => {
                reject(err)
            })
        })
    }

    protected getNextInstanceName() {
        let name = InstanceChecker.getOwnInstanceName()
        if (!name) {
            if (!nconf.get("debug"))
                logger.warn("Unable to get next instance to monitor bots. Dir path: %s", utils.appDir)
            return "";
        }
        if (argv.monitor === true) {
            // we have 1 instance named Sensor1 and its monitoring instanced named Sensor_monitor
            let removeRegex = new RegExp(utils.escapeRegex(nconf.get("serverConfig:monitoringInstanceDir")) + "$");
            name = name.replace(removeRegex, "1");
        }
        else {
            // we have multiple instances named Sensor1, Sensor2,...
            if (name.match(/[0-9]+$/) === null)
                return "";
            name = name.replace(/[0-9]+$/, (substring) => {
                let cur = parseInt(substring);
                cur++;
                if (cur > nconf.get("serverConfig:instanceCount"))
                    cur = 1;
                return cur.toString();
            })
        }
        logger.verbose("Next instance name to check: %s", name)
        return name;
    }

    protected checkInstanceRunning(botName: string) {
        return new Promise<void>((resolve, reject) => {
            if (os.platform() === 'win32') {
                logger.warn('Process monitoring not supported on windows. Skipped')
                return resolve()
            }
            else if (!botName) // no next instance to check available
                return resolve()

            let bundleRoot = path.resolve(utils.appDir + '..' + path.sep + botName + path.sep)
            let options = null
            const child = exec("ps aux | grep -v grep | grep '" + bundleRoot + "' | grep -v '_manual' | grep -v 'child' | awk '{print $2}'", options, (err, stdout, stderr) => {
                if (err)
                    return reject(err)
                let processIds = stdout.toString().split("\n") // should only be 1 bot // should already be a string
                processIds.forEach((strPID) => {
                    if (strPID == '')
                        return
                    const PID = parseInt(strPID)
                    if (PID == process.pid)
                        return

                    this.checkBotApiResponsive(botName).then((isResponsive) => {
                        if (isResponsive === false) {
                            // TODO verify again that it's still running?
                            const msg = utils.sprintf("Killing possibly stuck process: PID %s, last response %s", PID, utils.test.getPassedTime(this.lastResponse.getTime()));
                            logger.warn(msg)
                            this.notifyBotKill(botName, "is unresponsive", msg)
                            try {
                                process.kill(PID, "SIGKILL") // just kill it. bots get (re-)started by our bash script
                            }
                            catch (e) { // permission denied if we grep some wrong processes
                                logger.error('Error killing process with PID %s', PID, e)
                            }
                            this.copyBotLogfile(botName);
                        }
                        else {
                            logger.verbose("Bot %s with PID %s is running", botName, PID)
                            // store timestamp when bot was last running and also send notification
                            // checking modification timestamp of logfile doesn't mean bot is up (might crash on startup)
                            this.lastResponse = new Date();
                        }
                        resolve()
                    }).catch((err) => {
                        logger.error("Error checking if bot api is responsive", err)
                        resolve()
                    })
                })
            })
        })
    }

    protected checkLastRespnseTime(botName: string) {
        if (nconf.get("debug"))
            return; // don't send notification with local single debugging instance
        if (this.lastResponse.getTime() + nconf.get("serverConfig:assumeBotCrashedMin") * utils.constants.MINUTE_IN_SECONDS*1000 > Date.now())
            return;
        const msg = utils.sprintf("Last response: %s\nPort: %s", utils.test.getPassedTime(this.lastResponse.getTime()), this.lastPort);
        this.notifyBotKill(botName, "is not starting", msg);
    }

    protected checkBotApiResponsive(botName: string) {
        return new Promise<boolean>((resolve, reject) => {
            this.getBotApiPort(botName).then((port) => {
                const apiUrl = "https://localhost:" + port + "/state/"
                logger.verbose("Checking instance %s with URL: ", botName, apiUrl)
                this.lastPort = port;
                let data = {
                    apiKey: helper.getFirstApiKey()
                }
                let reqOptions = {skipCertificateCheck: true}
                utils.postDataAsJson(apiUrl, data, (body, res) => {
                    if (body === false || !utils.parseJson(body)) { // it's EJSON, but compatible
                        // do a 2nd check to be sure
                        setTimeout(() => {
                            utils.postDataAsJson(apiUrl, data, (body, res) => {
                                if (body === false || !utils.parseJson(body))
                                    return resolve(false)
                                resolve(true)
                            }, reqOptions)
                        }, nconf.get("serverConfig:instanceApiCheckRepeatingSec")*1000)
                        return
                    }
                    resolve(true)
                }, reqOptions)
            }).catch((err) => {
                reject(err)
            })
        })
    }

    protected copyBotLogfile(botName: string) {
        return new Promise<void>((resolve, reject) => {
            const otherLogfile = path.join(utils.appDir, nconf.get("logfile")).replace(new RegExp(nconf.get("projectName") + "[0-9]+", "g"), botName);
            // copy it to our app dir. or better keep it in the other bots dir? but we might not have write permissions there
            const copyDest = path.join(utils.appDir, nconf.get("logfile")).replace(/\.log$/, "-" + botName + ".log");
            utils.file.copy(otherLogfile, copyDest).then(() => {
                logger.info("Copied logfile of killed instance to %s", copyDest)
                resolve()
            }).catch((err) => {
                logger.error("Error copying bot logfile of killed instance to %s", copyDest, err)
                resolve()
            })
        })
    }

    protected getBotApiPort(botName: string) {
        return new Promise<number>((resolve, reject) => {
            let collection = db.get().collection(Process.COLLECTION_NAME)
            // TODO better support for multiple hosts. but our kill command only works locally either way
            // sort by lastContact to get the most recent one
            collection.find({
                name: botName,
                hostname: os.hostname()
            }).sort({lastContact: -1}).limit(1).toArray().then((docs) => {
                if (!docs || docs.length === 0)
                    return reject({txt: "Bot to get api port not found in database", name: botName, hostname: os.hostname()})
                const doc = docs[0];
                if (!doc.apiPort)
                    return reject({txt: "ApiPort for bot not set in database", name: botName, hostname: os.hostname()})
                resolve(doc.apiPort)
            }).catch((err) => {
                reject(err);
            })
        })
    }

    protected notifyBotKill(botName: string, title: string, message: string) {
        const pauseMs = nconf.get('serverConfig:notificationPauseMin') * utils.constants.MINUTE_IN_SECONDS * 1000;
        if (this.lastNotification && this.lastNotification.getTime() + pauseMs > Date.now()) // lastNotification per bot? we only monitor 1 instance per bot
            return;
        let headline = botName + " " + title;
        let notification = new Notification(headline, message, false);
        // TODO setting to always force a specific notification method (Pushover for admin notifications)
        this.notifier.send(notification).then(() => {
        }).catch((err) => {
            logger.error("Error sending %s notification", this.className, err)
        });
        this.lastNotification = new Date();
    }

}