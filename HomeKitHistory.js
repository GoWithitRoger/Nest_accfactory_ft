// HomeKit history service
// Simple history service for HomeKit developed accessories with HAP-NodeJS
//
// todo (EveHome integration)
// -- get history to show for motion when attached to a smoke sensor
// -- get history to show for smoke when attached to a smoke sensor
// -- thermo valve protection
// -- Eve Degree/Weather2 history
// -- Eve Water guard history
//
// done
// -- initial support for importing our history into EveHome
// -- developed simple history service for HomeKit HAP-NodeJS accessories
// -- import history for sprinkler/irrigation systems to EveHome (Aqua)
// -- fixed door history bug with inverted status
// -- notify Eve when new history entries added
// -- get humidity recordings for EveHome thermo
// -- Eve Room2 history returns
// -- internally check if specified minimun time between entries and if so, ignore logging it
// -- small correction to number formatting when retreving history for EveHome
// -- Storage access fix when using HAP-NodeJS as a library (removes dependancy on node-persist modules for this module)
// -- Debugging option
// -- refactor class definition
// -- fix for thermo history target temperatures
// -- thermo schedules
// -- updated history logging for outlet services
// -- inital support for Eve Water Guard
//
// Version 3/7/2023
// Mark Hulskamp

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define nodejs module requirements
var util = require("util");
var fs = require("fs");

// Define constants
const MAX_HISTORY_SIZE = 16384; // 16k entries
const EPOCH_OFFSET = 978307200; // Seconds since 1/1/1970 to 1/1/2001
const EVEHOME_MAX_STREAM = 11;  // Maximum number of history events we can stream to EveHome at once

const DAYSOFWEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];


// Create the history object
class HomeKitHistory {
	constructor(HomeKitAccessory, optionalParams) {
        this.maxEntries = MAX_HISTORY_SIZE; // used for rolling history. if 0, means no rollover
        this.location = "";
        this.debug = false; // No debugging by default

        if (typeof (optionalParams) === "object") {
            this.maxEntries = optionalParams.maxEntries || MAX_HISTORY_SIZE; // used for rolling history. if 0, means no rollover
            this.location = optionalParams.location || "";
            this.debug = optionalParams.debug || false;
        }

        // Setup HomeKitHistory storage using HAP-NodeJS persist location
        // can be overridden by passing in location optional parameter
        this.storageKey = util.format("History.%s.json", HomeKitAccessory.username.replace(/:/g, "").toUpperCase());

        this.storage = HAP.HAPStorage.storage();  // Load storage from HAP-NodeJS. We'll use it's persist folder for storing history files
		this.historyData = this.storage.getItem(this.storageKey);
		if (typeof this.historyData != "object") {
            // Getting storage key didnt return an object, we'll assume no history present, so start new history for this accessory
            this.resetHistory();    // Start with blank history
        }

        this.restart = Math.floor(new Date() / 1000);   // time we restarted

        // perform rollover if needed when starting service
        if (this.maxEntries != 0 && this.historyData.next >= this.maxEntries) {
            this.rolloverHistory();
        }
	}


    // Class functions
    addHistory(service, entry, timegap) {
        // we'll use the service or characteristic UUID to determine the history entry time and data we'll add
        // reformat the entry object to order the fields consistantly in the output
        // Add new history types in the switch statement
        var historyEntry = {};
        if (this.restart != null && typeof entry.restart == "undefined") {
            // Object recently created, so log the time restarted our history service 
            entry.restart = this.restart;
            this.restart = null;
        }
        if (typeof entry.time == "undefined") {
            // No logging time was passed in, so set
            entry.time = Math.floor(new Date() / 1000);
        }
        if (typeof service.subtype == "undefined") {
            service.subtype = 0;
        }
        if (typeof timegap == "undefined") {
            timegap = 0; // Zero minimum time gap between entries
        }
        switch (service.UUID) {
            case HAP.Service.GarageDoorOpener.UUID : {
                // Garage door history
                // entry.time => unix time in seconds
                // entry.status => 0 = closed, 1 = open
                historyEntry.status = entry.status;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.MotionSensor.UUID : {
                // Motion sensor history
                // entry.time => unix time in seconds
                // entry.status => 0 = motion cleared, 1 = motion detected
                historyEntry.status = entry.status;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.Window.UUID :
            case HAP.Service.WindowCovering.UUID : {
                // Window and Window Covering history
                // entry.time => unix time in seconds
                // entry.status => 0 = closed, 1 = open
                // entry.position => position in % 0% = closed 100% fully open
                historyEntry.status = entry.status;
                historyEntry.position = entry.position;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.HeaterCooler.UUID :
            case HAP.Service.Thermostat.UUID : {
                // Thermostat and Heater/Cooler history
                // entry.time => unix time in seconds
                // entry.status => 0 = off, 1 = fan, 2 = heating, 3 = cooling, 4 = dehumidifying
                // entry.temperature  => current temperature in degress C
                // entry.target => {low, high} = cooling limit, heating limit
                // entry.humidity => current humidity
                historyEntry.status = entry.status;
                historyEntry.temperature = entry.temperature;
                historyEntry.target = entry.target;
                historyEntry.humidity = entry.humidity;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.EveAirPressureSensor.UUID :
            case HAP.Service.AirQualitySensor.UUID :
            case HAP.Service.TemperatureSensor.UUID : {
                // Temperature sensor history
                // entry.time => unix time in seconds
                // entry.temperature => current temperature in degress C
                // entry.humidity => current humidity
                // optional (entry.ppm)
                // optional (entry.voc => current VOC measurement in ppb)\
                // optional (entry.pressure -> in hpa)
                historyEntry.temperature = entry.temperature;
                if (typeof entry.humidity == "undefined") {
                    // fill out humidity if missing
                    entry.humidity = 0;
                }
                if (typeof entry.ppm == "undefined") {
                    // fill out ppm if missing
                    entry.ppm = 0;
                }
                if (typeof entry.voc == "undefined") {
                    // fill out voc if missing
                    entry.voc = 0;
                }
                if (typeof entry.pressure == "undefined") {
                    // fill out pressure if missing
                    entry.pressure = 0;
                }
                historyEntry.temperature = entry.temperature;
                historyEntry.humidity = entry.humidity;
                historyEntry.ppm = entry.ppm;
                historyEntry.voc = entry.voc;
                historyEntry.pressure = entry.pressure;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.Valve.UUID : {
                // Water valve history
                // entry.time => unix time in seconds
                // entry.status => 0 = valve closed, 1 = valve opened
                // entry.water => amount of water in L's
                // entry.duration => time for water amount
                historyEntry.status = entry.status;
                historyEntry.water = entry.water;
                historyEntry.duration = entry.duration;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Characteristic.WaterLevel.UUID : {
                // Water level history
                // entry.time => unix time in seconds
                // entry.level => water level as percentage
                historyEntry.level = entry.level;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, 0, entry.time, timegap, historyEntry); // Characteristics dont have sub type, so we'll use 0 for it
                break;
            }

            case HAP.Service.LeakSensor.UUID : {
                // Leak sensor history
                // entry.time => unix time in seconds
                // entry.status => 0 = no leak, 1 = leak
                historyEntry.status = entry.status;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, 0, entry.time, timegap, historyEntry); // Characteristics dont have sub type, so we'll use 0 for it
                break;
            }

            case HAP.Service.Outlet.UUID : {
                // Power outlet history
                // entry.time => unix time in seconds
                // entry.status => 0 = off, 1 = on
                // entry.volts  => voltage in Vs
                // entry.watts  => watts in W's
                // entry.amps  => current in A's
                historyEntry.status = entry.status;
                historyEntry.volts = entry.volts;
                historyEntry.watts = entry.watts;
                historyEntry.amps = entry.amps;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.Doorbell.UUID : {
                // Doorbell press history
                // entry.time => unix time in seconds
                // entry.status => 0 = not pressed, 1 = doorbell pressed
                historyEntry.status = entry.status;
                if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }

            case HAP.Service.SmokeSensor.UUID : {
                // Smoke sensor history
                // entry.time => unix time in seconds
                // entry.status => 0 = smoke cleared, 1 = smoke detected
                historyEntry.status = entry.status;
                if (typeof historyEntry.restart != "undefined") historyEntry.restart = entry.restart;
                this.#addEntry(service.UUID, service.subtype, entry.time, timegap, historyEntry);
                break;
            }
        }
    }

    resetHistory() {
        // Reset history to nothing
        this.historyData = {};
        this.historyData.reset = Math.floor(new Date() / 1000); // time history was reset
        this.historyData.rollover = 0;  // no last rollover time
        this.historyData.next = 0;      // next entry for history is at start
        this.historyData.types = [];    // no service types in history
        this.historyData.data = [];     // no history data
        this.storage.setItem(this.storageKey, this.historyData);
    }

    rolloverHistory() {
        // Roll history over and start from zero.
        // We'll include an entry as to when the rollover took place
        // remove all history data after the rollover entry
        this.historyData.data.splice(this.maxEntries, this.historyData.data.length);
        this.historyData.rollover = Math.floor(new Date() / 1000);
        this.historyData.next = 0;
        this.#updateHistoryTypes();
        this.storage.setItem(this.storageKey, this.historyData);
    }

    #addEntry(type, sub, time, timegap, entry) {
        var historyEntry = {};
        var recordEntry = true; // always record entry unless we dont need to 
        historyEntry.time = time;
        historyEntry.type = type;
        historyEntry.sub = sub;
        Object.entries(entry).forEach(([key, value]) => {
            if (key != "time" || key != "type" || key != "sub") {
                // Filer out events we want to control
                historyEntry[key] = value;
            }
        });

        // If we have a minimum time gap specified, find the last time entry for this type and if less than min gap, ignore
        if (timegap != 0) {
            var typeIndex = this.historyData.types.findIndex(type => (type.type == historyEntry.type && type.sub == historyEntry.sub));
            if (typeIndex >= 0 && (time - this.historyData.data[this.historyData.types[typeIndex].lastEntry].time < timegap) && typeof historyEntry.restart == "undefined") {
                // time between last recorded entry and this new entry is less than minimum gap specified and its not a "restart" entry, so don't log it
                recordEntry = false;
            }
        }
    
        if (recordEntry == true) {
            // Work out where this goes in the history data array
            if (this.maxEntries != 0 && this.historyData.next >= this.maxEntries) {
                // roll over history data as we've reached the defined max entry size
                this.rolloverHistory();
            }
            this.historyData.data[this.historyData.next] = historyEntry;
            this.historyData.next++;

            // Update types we have in history. This will just be the main type and its latest location in history
            var typeIndex = this.historyData.types.findIndex(type => (type.type == historyEntry.type && type.sub == historyEntry.sub));
            if (typeIndex == -1) {
                this.historyData.types.push({type: historyEntry.type, sub: historyEntry.sub, lastEntry: (this.historyData.next - 1)});
            } else {
                this.historyData.types[typeIndex].lastEntry = (this.historyData.next - 1);
            }

            // Validate types last entries. Helps with rolled over data etc. If we cannot find the type anymore, remove from known types
            this.historyData.types.forEach((typeEntry, index) => {
                if (this.historyData.data[typeEntry.lastEntry].type !== typeEntry.type) {
                    // not found, so remove from known types
                    this.historyData.types.splice(index, 1);
                }
            });

            this.storage.setItem(this.storageKey, this.historyData); // Save to persistent storage
        }
    }

    getHistory(service, subtype, specifickey) {
        // returns a JSON object of all history for this service and subtype
        // handles if we've rolled over history also
        var tempHistory = [];
        var findUUID = null;
        var findSub = null;
        if (typeof subtype != "undefined" && subtype != null) {
            findSub = subtype;
        }
        if (typeof service != "object") {
            // passed in UUID byself, rather than service object
            findUUID = service;
        }
        if (typeof service == "object" && service.hasOwnProperty("UUID") == true) {
            findUUID = service.UUID;
        }
        if (typeof service.subtype == "undefined" && typeof subtype == "undefined") {
            findSub = 0;
        }
        tempHistory = tempHistory.concat(this.historyData.data.slice(this.historyData.next, this.historyData.data.length), this.historyData.data.slice(0, this.historyData.next));
        tempHistory = tempHistory.filter(historyEntry => {
            if (specifickey && typeof specifickey == "object" && Object.keys(specifickey).length == 1) {
                // limit entry to a specifc key type value if specified
                if ((findSub == null && historyEntry.type == findUUID && historyEntry[Object.keys(specifickey)] == Object.values(specifickey)) || (findSub != null && historyEntry.type == findUUID && historyEntry.sub == findSub && historyEntry[Object.keys(specifickey)] == Object.values(specifickey))) {
                    return historyEntry;
                }
            } else if ((findSub == null && historyEntry.type == findUUID) || (findSub != null && historyEntry.type == findUUID && historyEntry.sub == findSub)) {
                return historyEntry;
            }
        });
        return tempHistory;
    }

    generateCSV(service, csvfile) {
        // Generates a CSV file for use in applications such as Numbers/Excel for graphing
        // we get all the data for the service, ignoring the specific subtypes
        var tempHistory = this.getHistory(service, null); // all history
        if (tempHistory.length != 0) {
            var writer = fs.createWriteStream(csvfile, {flags: "w", autoClose: "true"});
            if (writer != null) {
                // write header, we'll use the first record keys for the header keys
                var header = "time,subtype";
                Object.keys(tempHistory[0]).forEach(key => {
                    if (key != "time" && key != "type" && key != "sub" && key != "restart") {
                        header = header + "," + key;
                    }
                });
                writer.write(header + "\n");

                // write data
                // Date/Time converted into local timezone
                tempHistory.forEach(historyEntry => {
                    var csvline = new Date(historyEntry.time * 1000).toLocaleString().replace(",", "") + "," + historyEntry.sub;
                    Object.entries(historyEntry).forEach(([key, value]) => {
                        if (key != "time" && key != "type" && key != "sub" && key != "restart") {
                            csvline = csvline + "," + value;
                        }
                    });
                    writer.write(csvline + "\n");
                });
                writer.end();
            }
        }
    }

    lastHistory(service, subtype) {
        // returns the last history event for this service type and subtype
        var findUUID = null;
        var findSub = null;
        if (typeof subtype != "undefined") {
            findSub = subtype;
        }
        if (typeof service != "object") {
            // passed in UUID byself, rather than service object
            findUUID = service;
        }
        if (typeof service == "object" && service.hasOwnProperty("UUID") == true) {
            findUUID = service.UUID;
        }
        if (typeof service.subtype == "undefined" && typeof subtype == "undefined") {
            findSub = 0;
        }

        // If subtype is "null" find newest event based on time
        var typeIndex = this.historyData.types.findIndex(type => ((type.type == findUUID && type.sub == findSub && subtype != null) || (type.type == findUUID && subtype == null)));
        return (typeIndex != -1 ? this.historyData.data[this.historyData.types[typeIndex].lastEntry] : null);
    }

    entryCount(service, subtype, specifickey) {
        // returns the number of history entries for this service type and subtype
        // can can also be limited to a specific key value
        var tempHistory = this.getHistory(service, subtype, specifickey);
        return tempHistory.length;
    }

    #updateHistoryTypes() {
        // Builds the known history types and last entry in current history data
        // Might be time consuming.....
        this.historyData.types = [];
        for (var index = (this.historyData.data.length - 1); index > 0; index--) {
            if (this.historyData.types.findIndex(type => ((typeof type.sub != "undefined" && type.type == this.historyData.data[index].type && type.sub == this.historyData.data[index].sub) || (typeof type.sub == "undefined" && type.type == this.historyData.data[index].type))) == -1) {
                this.historyData.types.push({type: this.historyData.data[index].type, sub: this.historyData.data[index].sub, lastEntry: index});
            }
        }
    }

    // Overlay EveHome service, characteristics and functions
    // Alot of code taken from fakegato https://github.com/simont77/fakegato-history
    // references from https://github.com/ebaauw/homebridge-lib/blob/master/lib/EveHomeKitTypes.js
    //

    // Overlay our history into EveHome. Can only have one service history exposed to EveHome (ATM... see if can work around)
    // Returns object created for our EveHome accessory if successfull
    linkToEveHome(HomeKitAccessory, service, optionalParams) {
        var allowReset = false;
        var SetCommand = null;
        var GetCommand = null;
        if (typeof (optionalParams) === "object") {
            allowReset = optionalParams.allowReset || false;    // Allow EveHome to reset our history (clear it)
            SetCommand = optionalParams.SetCommand || null;     // function for set data for commands outside of this library
            GetCommand = optionalParams.GetCommand || null;     // function for get data for commands outside of this library
        }

        if (typeof this.EveHome == "undefined" || (this.EveHome && this.EveHome.hasOwnProperty("service") == false)) {
            switch (service.UUID) {
                case HAP.Service.Door.UUID :
                case HAP.Service.Window.UUID :
                case HAP.Service.GarageDoorOpener.UUID : {
                    // treat these as EveHome Door but with inverse status for open/closed
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "door", fields: "0601", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                    service.addCharacteristic(HAP.Characteristic.EveLastActivation);
                    service.addCharacteristic(HAP.Characteristic.EveOpenDuration);
                    service.addCharacteristic(HAP.Characteristic.EveClosedDuration);
                    service.addCharacteristic(HAP.Characteristic.EveTimesOpened);

                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveTimesOpened, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
                    service.updateCharacteristic(HAP.Characteristic.EveLastActivation, this.#EveLastEventTime()); // time of last event in seconds since first event
                    
                    service.getCharacteristic(HAP.Characteristic.EveTimesOpened).on("get", (callback) => {
                        callback(null, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));  // Count of entries based upon status = 1, opened
                    });
                    
                    service.getCharacteristic(HAP.Characteristic.EveLastActivation).on("get", (callback) => {
                        callback(null, this.#EveLastEventTime());  // time of last event in seconds since first event
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Door & Window");
                    break;
                }

                case HAP.Service.ContactSensor.UUID : {
                    // treat these as EveHome Door
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "contact", fields: "0601", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                    service.addCharacteristic(HAP.Characteristic.EveLastActivation);
                    service.addCharacteristic(HAP.Characteristic.EveOpenDuration);
                    service.addCharacteristic(HAP.Characteristic.EveClosedDuration);
                    service.addCharacteristic(HAP.Characteristic.EveTimesOpened);

                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveTimesOpened, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
                    service.updateCharacteristic(HAP.Characteristic.EveLastActivation, this.#EveLastEventTime()); // time of last event in seconds since first event
                    
                    service.getCharacteristic(HAP.Characteristic.EveTimesOpened).on("get", (callback) => {
                        callback(null, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1})); // Count of entries based upon status = 1, opened
                    });
                    
                    service.getCharacteristic(HAP.Characteristic.EveLastActivation).on("get", (callback) => {
                        callback(null, this.#EveLastEventTime());  // time of last event in seconds since first event
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Door & Window");
                    break;
                }

                case HAP.Service.WindowCovering.UUID : 
                {
                    // Treat as Eve MotionBlinds
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
                    
                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "blind", fields: "1702 1802 1901", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);

                    //17      CurrentPosition
                    //18      TargetPosition
                    //19      PositionState

               
                  /*  var index = 80;
                    var uuid = "E863F1" + numberToEveHexString(index, 2) + "-079E-48FF-8F27-9C2605A29F52".toLocaleUpperCase();
                    eval(`HAP.Characteristic.EveTest`+ index + ` =function() {HAP.Characteristic.call(this, "Eve Test "+ index, uuid); this.setProps({format: HAP.Characteristic.Formats.DATA,perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]});this.value = this.getDefaultValue();}`);
                    util.inherits(eval(`HAP.Characteristic.EveTest`+ index), HAP.Characteristic);
                    eval(`HAP.Characteristic.EveTest`+ index + `.UUID = uuid`);
                    if (service.testCharacteristic(eval(`HAP.Characteristic.EveTest`+ index)) == false) {
                        service.addCharacteristic(eval(`HAP.Characteristic.EveTest`+ index));
                        console.log(uuid)
                    } */


                    service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).on("get", (callback) => {
                        var value = util.format(
                            "0002 5500 0302 %s 9b04 %s 1e02 5500 0c",
                            numberToEveHexString(2979, 4),  // firmware version (build xxxx)
                            numberToEveHexString(Math.floor(new Date() / 1000), 8)); // "now" time
     
                            callback(null, encodeEveData(value));
                    });

                    service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).on("set", (value, callback) => {
                        var processedData = {};
                        var valHex = decodeEveData(value);
                        var index = 0;

                        console.log("EveSetConfiguration", valHex);

                        while (index < valHex.length) {
                            // first byte is command in this data stream
                            // second byte is size of data for command
                            var command = valHex.substr(index, 2);
                            var size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                            var data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                            switch(command) {
                                case "00" : {
                                    // end of command?
                                    break;
                                }

                                case "f0" : {
                                    // set limits
                                    // data
                                    // 02 bottom position set
                                    // 01 top position set
                                    // 04 favourite position set
                                    break;
                                }

                                case "f1" : {
                                    // orientation set??
                                    break;
                                }

                                case "f3" : {
                                    // move window covering to set limits
                                    // xxyyyy - xx = move command (01 = up, 02 = down, 03 = stop), yyyy - distance/time/ticks/increment to move??
                                    var moveCommand = data.substring(0, 2);
                                    var moveAmount = EveHexStringToNumber(data.substring(2));

                                    console.log("move", moveCommand, moveAmount);

                                    var currentPosition = service.getCharacteristic(HAP.Characteristic.CurrentPosition).value;
                                    if (data == "015802") {
                                        currentPosition = currentPosition + 1;
                                    }
                                    if (data == "025802") {
                                        currentPosition = currentPosition - 1;
                                    }
                                    console.log("move", currentPosition, data)
                                    service.updateCharacteristic(HAP.Characteristic.CurrentPosition, currentPosition);
                                    service.updateCharacteristic(HAP.Characteristic.TargetPosition, currentPosition);
                                    break;
                                }

                                default : {
                                    this.#outputLogging("History", true,  "Unknown Eve MotionBlinds command '%s' with data '%s'", command, data);
                                    break;
                                }
                            }
                            index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                        }
                        callback();
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Motion Blinds");
                    break;
                }

                case HAP.Service.HeaterCooler.UUID :
                case HAP.Service.Thermostat.UUID : {
                    // treat these as EveHome Thermo
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "thermo", fields: "0102 0202 1102 1001 1201 1d01", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0}; 
                    
                    // Need some internal storage to track Eve Thermo configuration from EveHome app
                    this.EveThermoPersist = {};
                    this.EveThermoPersist.firmware = optionalParams.hasOwnProperty("EveThermo_firmware") ? optionalParams.EveThermo_firmware : 1251; // Firmware version 1251 2015 thermo, 2834 2020 thermo
                    this.EveThermoPersist.attached = optionalParams.hasOwnProperty("EveThermo_attached") ? optionalParams.EveThermo_attached : false; // attached to base?
                    this.EveThermoPersist.tempoffset = optionalParams.hasOwnProperty("EveThermo_tempoffset") ? optionalParams.EveThermo_tempoffset: -2.5; // Temperature offset. default -2.5
                    this.EveThermoPersist.enableschedule = optionalParams.hasOwnProperty("EveThermo_enableschedule") ? optionalParams.EveThermo_enableschedule : false; // Schedules on/off
                    this.EveThermoPersist.pause = optionalParams.hasOwnProperty("EveThermo_pause") ? optionalParams.EveThermo_pause : false; // Paused on/off
                    this.EveThermoPersist.vacation = optionalParams.hasOwnProperty("EveThermo_vacation") ? optionalParams.EveThermo_vacation : false; // Vacation status - disabled ie: Home
                    this.EveThermoPersist.vacationtemp = optionalParams.hasOwnProperty("EveThermo_vacationtemp") ? optionalParams.EveThermo_vactiontemp : null; // Vacation temp disabled if null
                    this.EveThermoPersist.datetime = optionalParams.hasOwnProperty("EveThermo_datetime") ? optionalParams.EveThermo_datetime : new Date(); // Current date/time
                    this.EveThermoPersist.programs = optionalParams.hasOwnProperty("EveThermo_programs") ? optionalParams.EveThermo_programs : [];
                    
                    service.addCharacteristic(HAP.Characteristic.EveValvePosition);   // Needed to show history for thermostat heating modes (valve position)
                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                    service.addCharacteristic(HAP.Characteristic.EveProgramData);
                    service.addCharacteristic(HAP.Characteristic.EveProgramCommand);
                    if (service.testCharacteristic(HAP.Characteristic.StatusActive) === false) service.addCharacteristic(HAP.Characteristic.StatusActive);
                    if (service.testCharacteristic(HAP.Characteristic.CurrentTemperature) === false) service.addCharacteristic(HAP.Characteristic.CurrentTemperature);
                    if (service.testCharacteristic(HAP.Characteristic.TemperatureDisplayUnits) === false) service.addCharacteristic(HAP.Characteristic.TemperatureDisplayUnits);
                    if (service.testCharacteristic(HAP.Characteristic.LockPhysicalControls) == false) service.addCharacteristic(HAP.Characteristic.LockPhysicalControls); // Allows childlock toggle to be displayed in Eve App

                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format("2c %s be", numberToEveHexString(this.EveThermoPersist.firmware, 4))));  // firmware version (build xxxx)));
                    
                    service.updateCharacteristic(HAP.Characteristic.EveProgramData, this.#EveThermoGetDetails(optionalParams.GetCommand));
                    service.getCharacteristic(HAP.Characteristic.EveProgramData).on("get", (callback) => {
                        callback(null, this.#EveThermoGetDetails(optionalParams.GetCommand));
                    });

                    service.getCharacteristic(HAP.Characteristic.EveProgramCommand).on("set", (value, callback) => {
                        var programs = [];
                        var scheduleTemps = [];
                        var processedData = {};
                        var valHex = decodeEveData(value);
                        var index = 0;
                        while (index < valHex.length) {
                            var command = valHex.substr(index, 2);
                            index += 2; // skip over command value, and this is where data starts.
                            switch(command) {
                                case "00" : {
                                    // start of command string ??
                                    break;
                                }
                                
                                case "06" : {
                                    // end of command string ??
                                    break;
                                }

                                case "7f" : {
                                    // end of command string ??
                                    break;
                                }

                                case "11" : {
                                    // valve calibration/protection??
                                    //0011ff00f22076
                                    // 00f22076 - 111100100010000001110110
                                    //            15868022
                                    // 7620f2   - 011101100010000011110010
                                    //            7741682
                                    console.log(Math.floor(new Date() / 1000));
                                    index += 10;
                                    break;
                                }

                                case "10" : {
                                    // OK to remove
                                    break;
                                }

                                case "12" : {
                                    // temperature offset
                                    var tempOffset = parseInt(valHex.substr(index, 2), 16);
                                    if (tempOffset > 127) tempOffset = tempOffset - 256;
                                    tempOffset = tempOffset / 10;
                                    this.EveThermoPersist.tempoffset = tempOffset;
                                    processedData.tempoffset = this.EveThermoPersist.tempoffset;
                                    index += 2;
                                    break;
                                }
                                
                                case "13" : {
                                    // schedules enabled/disable
                                    this.EveThermoPersist.enableschedule = valHex.substr(index, 2) == "01" ? true : false;
                                    processedData.enableschedule = this.EveThermoPersist.enableschedule;
                                    index += 2;
                                    break;
                                }

                                case "14" : {
                                    // Installed status
                                    index += 2;
                                    break;
                                }

                                case "18" : {
                                    // Pause/resume via HomeKit automation/scene
                                    // 20 - pause thermostat operation
                                    // 10 - resume thermostat operation
                                    this.EveThermoPersist.pause = valHex.substr(index, 2) == "20" ? true : false;
                                    processedData.pause = this.EveThermoPersist.pause;
                                    index += 2;
                                    break;
                                }

                                case "19" : {
                                    // Vacation on/off, vacation temperature via HomeKit automation/scene
                                    this.EveThermoPersist.vacation = valHex.substr(index, 2) == "01" ? true : false;
                                    this.EveThermoPersist.vacationtemp = (valHex.substr(index, 2) == "01" ? parseInt(valHex.substr(index + 2, 2), 16) * 0.5 : null);
                                    processedData.vacation = {"status": this.EveThermoPersist.vacation, "temp": this.EveThermoPersist.vacationtemp};
                                    index += 4;
                                    break;
                                }

                                case "f4" : {
                                    // Temperature Levels for schedule
                                    var nowTemp = valHex.substr(index, 2) == "80" ? null : parseInt(valHex.substr(index, 2), 16) * 0.5;
                                    var ecoTemp = valHex.substr(index + 2, 2) == "80" ? null : parseInt(valHex.substr(index + 2, 2), 16) * 0.5;
                                    var comfortTemp = valHex.substr(index + 4, 2) == "80" ? null : parseInt(valHex.substr(index + 4, 2), 16) * 0.5;
                                    scheduleTemps = [ecoTemp, comfortTemp];
                                    processedData.scheduleTemps = {"eco": ecoTemp, "comfort": comfortTemp};
                                    index += 6;
                                    break;
                                }

                                case "fc" : {
                                    // Date/Time mmhhDDMMYY
                                    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                                    var minute = parseInt(valHex.substr(index, 2), 16);
                                    var hour = parseInt(valHex.substr(index + 2, 2), 16);
                                    var day = parseInt(valHex.substr(index + 4, 2), 16);
                                    var month = parseInt(valHex.substr(index + 6, 2), 16);
                                    var year = parseInt(valHex.substr(index + 8, 2), 16);
                                    this.EveThermoPersist.datetime = new Date(months[month - 1] + " " + day + ", " + year + " " + hour + ":" + minute + ":00");
                                    processedData.datetime = this.EveThermoPersist.datetime;
                                    index += 10;
                                    break;
                                }       

                                case "fa" : {
                                    // Programs (week - mon, tue, wed, thu, fri, sat, sun)
                                    // index += 112;
                                    for (var index2 = 0; index2 < 7; index2++) {
                                        var times = [];
                                        for (var index3 = 0; index3 < 4; index3++) {
                                            // decode start time
                                            var start = parseInt(valHex.substr(index, 2), 16);
                                            var start_min = null;
                                            var start_hr = null;
                                            var start_offset = null;
                                            if (start != 0xff) {
                                                start_min = (start * 10) % 60;   // Start minute
                                                start_hr = ((start * 10) - start_min) / 60;    // Start hour
                                                start_offset = ((start * 10) * 60);    // Seconds since 00:00
                                            }

                                            // decode end time
                                            var end = parseInt(valHex.substr(index + 2, 2), 16);
                                            var end_min = null;
                                            var end_hr = null;
                                            var end_offset = null;
                                            if (end != 0xff) {
                                                end_min = (end * 10) % 60;   // End minute
                                                end_hr = ((end * 10) - end_min) / 60;    // End hour
                                                end_offset = ((end * 10) * 60);    // Seconds since 00:00
                                            }
                
                                            if (start_offset != null && end_offset != null) {
                                                times.push({"start": start_offset, "duration" : (end_offset - start_offset), "ecotemp" : scheduleTemps.eco, "comforttemp" : scheduleTemps.comfort});
                                            }
                                            index += 4;
                                        }
                                        programs.push({"id": (programs.length + 1), "days": DAYSOFWEEK[index2], "schedule": times });
                                    }

                                    this.EveThermoPersist.programs = programs;
                                    processedData.programs = this.EveThermoPersist.programs;           
                                    break;
                                }

                                case "1a" : {
                                    // Program (day)
                                    index += 16;
                                    break;
                                }

                                case "f2" : {
                                    // ??
                                    index += 2;
                                    break;
                                }  

                                case "f6" : {
                                    //??
                                    index += 6;
                                    break;
                                }

                                case "ff" : {
                                    // ??
                                    index += 4;
                                    break;
                                }

                                default : {
                                    this.#outputLogging("History", true,  "Unknown Eve Thermo command '%s'", command);
                                    break
                                }
                            }
                        };

                        // Send complete processed command data if configured to our callback
                        if (typeof optionalParams.SetCommand == "function" && Object.keys(processedData).length != 0) optionalParams.SetCommand(processedData);
                        callback();
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Thermo");
                    break;
                }

                case HAP.Service.EveAirPressureSensor.UUID : {
                    // treat these as EveHome Weather (2015)
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                    service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format("01 %s be", numberToEveHexString(809, 4))));  // firmware version (build xxxx)));

                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "weather", fields: "0102 0202 0302", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Weather");
                    break;
                }

                case HAP.Service.AirQualitySensor.UUID :
                case HAP.Service.TemperatureSensor.UUID : {
                    // treat these as EveHome Room(s)
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    service.addCharacteristic(HAP.Characteristic.EveFirmware);

                    if (service.UUID == HAP.Service.AirQualitySensor.UUID) {
                        // Eve Room 2 (2018)
                        service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format("27 %s be", numberToEveHexString(1416, 4))));  // firmware version (build xxxx)));

                        this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "room2", fields: "0102 0202 2202 2901 2501 2302 2801", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                        if (service.testCharacteristic(HAP.Characteristic.VOCDensity) == false) service.addCharacteristic(HAP.Characteristic.VOCDensity);

                        // Need to ensure HomeKit accessory which has Air Quality service also has temperature & humidity services.
                        // Temperature service needs characteristic HAP.Characteristic.TemperatureDisplayUnits set to HAP.Characteristic.TemperatureDisplayUnits.CELSIUS
                    }

                    if (service.UUID == HAP.Service.TemperatureSensor.UUID) {
                        // Eve Room (2015)
                        service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format("02 %s be", numberToEveHexString(1151, 4))));  // firmware version (build xxxx)));

                        this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "room", fields: "0102 0202 0402 0f03", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                        if (service.testCharacteristic(HAP.Characteristic.TemperatureDisplayUnits) == false) service.addCharacteristic(HAP.Characteristic.TemperatureDisplayUnits); // Needed to show history for temperature
                        service.updateCharacteristic(HAP.Characteristic.TemperatureDisplayUnits, HAP.Characteristic.TemperatureDisplayUnits.CELSIUS);  // Temperature needs to be in Celsius
                    }

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Room");
                    break;
                }

                case HAP.Service.MotionSensor.UUID : {
                    // treat these as EveHome Motion
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    // Need some internal storage to track Eve Motion configuration from EveHome app
                    this.EveMotionPersist = {};
                    this.EveMotionPersist.duration = optionalParams.hasOwnProperty("EveMotion_duration") ? optionalParams.EveMotion_duration : 5; // default 5 seconds
                    this.EveMotionPersist.sensitivity = optionalParams.hasOwnProperty("EveMotion_sensitivity") ? optionalParams.EveMotion_sensivity : HAP.Characteristic.EveSensitivity.HIGH; // default sensitivity
                    this.EveMotionPersist.ledmotion = optionalParams.hasOwnProperty("EveMotion_ledmotion") ? optionalParams.EveMotion_ledmotion: false; // off

                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "motion", fields:"1301 1c01", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                    service.addCharacteristic(HAP.Characteristic.EveSensitivity);
                    service.addCharacteristic(HAP.Characteristic.EveDuration);
                    service.addCharacteristic(HAP.Characteristic.EveLastActivation);
                    //service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                    //service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);

                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveLastActivation, this.#EveLastEventTime()); // time of last event in seconds since first event
                    service.getCharacteristic(HAP.Characteristic.EveLastActivation).on("get", (callback) => {
                        callback(null, this.#EveLastEventTime());  // time of last event in seconds since first event
                    });

                    service.updateCharacteristic(HAP.Characteristic.EveSensitivity, this.EveMotionPersist.sensitivity);
                    service.getCharacteristic(HAP.Characteristic.EveSensitivity).on("get", (callback) => {
                        callback(null, this.EveMotionPersist.sensitivity);
                    });
                    service.getCharacteristic(HAP.Characteristic.EveSensitivity).on("set", (value, callback) => {
                        this.EveMotionPersist.sensitivity = value;
                        callback();
                    });

                    service.updateCharacteristic(HAP.Characteristic.EveDuration, this.EveMotionPersist.duration);
                    service.getCharacteristic(HAP.Characteristic.EveDuration).on("get", (callback) => {
                        callback(null, this.EveMotionPersist.duration);
                    });
                    service.getCharacteristic(HAP.Characteristic.EveDuration).on("set", (value, callback) => {
                        this.EveMotionPersist.duration = value; 
                        callback();
                    });

                    /*service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, encodeEveData("300100"));
                    service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).on("get", (callback) => {
                        var value = util.format(
                            "0002 2500 0302 %s 9b04 %s 8002 ffff 1e02 2500 0c",
                            numberToEveHexString(1144, 4),  // firmware version (build xxxx)
                            numberToEveHexString(Math.floor(new Date() / 1000), 8), // "now" time
                        );    // Not sure why 64bit value???
        
                        console.log("Motion set", value)
            
                        callback(null, encodeEveData(value));
                    });
                    service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).on("set", (value, callback) => {
                        var valHex = decodeEveData(value);
                        var index = 0;
                        while (index < valHex.length) {
                            // first byte is command in this data stream
                            // second byte is size of data for command
                            var command = valHex.substr(index, 2);
                            var size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                            var data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                            switch(command) {
                                case "30" : {
                                    this.EveMotionPersist.ledmotion = (data == "01" ? true : false);
                                    break;
                                }

                                case "80" : {
                                    //0000 0400 (mostly) and sometimes 300103 and 80040000 ffff
                                    break;
                                }

                                default : {
                                    this.#outputLogging("History", true,  "Unknown Eve Motion command '%s' with data '%s'", command, data);
                                    break;
                                }
                            }
                            index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                        }
                        callback();
                    }); */

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Motion");
                    break;
                }

                case HAP.Service.SmokeSensor.UUID : {
                    // treat these as EveHome Smoke
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
                    // TODO = work out what the "signatures" need to be for an Eve Smoke
                    // Also, how to make alarm test button active in Eve app and not say "Eve Smoke is not mounted correctly"
            
                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "smoke", fields: "1601 1b02 0f03 2302", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};

                    // Need some internal storage to track Eve Smoke configuration from EveHome app
                    this.EveSmokePersist = {};
                    this.EveSmokePersist.firmware = optionalParams.hasOwnProperty("EveSmoke_firmware") ? optionalParams.EveSmoke_firmware : 1208; // Firmware version
                    this.EveSmokePersist.lastalarmtest = optionalParams.hasOwnProperty("EveSmoke_lastalarmtest") ? optionalParams.EveSmoke_lastalarmtest : 0; // Time in seconds of alarm test
                    this.EveSmokePersist.alarmtest = optionalParams.hasOwnProperty("EveSmoke_alarmtest") ? optionalParams.EveSmoke_alarmtest : false; // Is alarmtest running
                    this.EveSmokePersist.heatstatus = optionalParams.hasOwnProperty("EveSmoke_heatstatus") ? optionalParams.EveSmoke_heatstatus : 0; // Heat sensor status
                    this.EveSmokePersist.statusled = optionalParams.hasOwnProperty("EveSmoke_statusled") ? optionalParams.EveSmoke_statusled: true; // Status LED flash/enabled
                    this.EveSmokePersist.smoketestpassed = optionalParams.hasOwnProperty("EveSmoke_smoketestpassed") ? optionalParams.EveSmoke_smoketestpassed: true; // Passed smoke test?
                    this.EveSmokePersist.heattestpassed = optionalParams.hasOwnProperty("EveSmoke_heattestpassed") ? optionalParams.EveSmoke_heattestpassed: true; // Passed smoke test?
                    this.EveSmokePersist.hushedstate = optionalParams.hasOwnProperty("EveSmoke_hushedstate") ? optionalParams.EveSmoke_hushedstate : false; // Alarms muted
        
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);
                    service.addCharacteristic(HAP.Characteristic.EveDeviceStatus);
            
                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveDeviceStatus, this.#EveSmokeGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveDeviceStatus));
                    service.getCharacteristic(HAP.Characteristic.EveDeviceStatus).on("get", (callback) => {
                        callback(null, this.#EveSmokeGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveDeviceStatus));
                    });
    
                    service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveSmokeGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveGetConfiguration));
                    service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).on("get", (callback) => {
                        callback(null, this.#EveSmokeGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveGetConfiguration));
                    });

                    service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).on("set", (value, callback) => {
                        // Loop through set commands passed to us
                        var processedData = {};
                        var valHex = decodeEveData(value);
                        var index = 0;
                        while (index < valHex.length) {
                            // first byte is command in this data stream
                            // second byte is size of data for command
                            var command = valHex.substr(index, 2);
                            var size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                            var data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                            switch(command) {
                                case "40" : {
                                    var subCommand = EveHexStringToNumber(data.substr(0, 2));
                                    if (subCommand == 0x02) {
                                        // Alarm test start/stop
                                        this.EveSmokePersist.alarmtest = (data == "0201") ? true : false;
                                        processedData.alarmtest = this.EveSmokePersist.alarmtest;
                                    }
                                    if (subCommand == 0x05) {
                                        // Flash status Led on/off
                                        this.EveSmokePersist.statusled = (data == "0501") ? true : false;
                                        processedData.statusled = this.EveSmokePersist.statusled;
                                    }
                                    if (subCommand != 0x02 && subCommand != 0x05) {
                                        this.#outputLogging("History", true,  "Unknown Eve Smoke command '%s' with data '%s'", command, data);
                                    }
                                    break;
                                }

                            // case "41" : {
                                // "59b8" - "b859" - 1011100001011001 17/3
                                // "8aa5" - "a58a" - 1010010110001010 18/3
                                // "6ef7" - "f76e"  - 30/5/23
                                //   break;
                            // }

                                default : {
                                    this.#outputLogging("History", true,  "Unknown Eve Smoke command '%s' with data '%s'", command, data);
                                    break;
                                }
                            }
                            index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                        };

                        // Send complete processed command data if configured to our callback
                        if (typeof optionalParams.SetCommand == "function" && Object.keys(processedData).length != 0) optionalParams.SetCommand(processedData);
                        callback();
                    });
        
                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Smoke");
                    break;
                }

                case HAP.Service.Valve.UUID :
                case HAP.Service.IrrigationSystem.UUID : {
                    // treat an irrigation system as EveHome Aqua
                    // Under this, any valve history will be presented under this. We dont log our History under irrigation service ID at all

                    // TODO - see if we can add history per valve service under the irrigation system????. History service per valve???
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);  
                    var tempHistory = this.getHistory(HAP.Service.Valve.UUID, (service.UUID == HAP.Service.IrrigationSystem.UUID ? null : service.subtype));
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
    
                    this.EveHome = {service: historyService, linkedservice: service, type: HAP.Service.Valve.UUID, sub: (service.UUID == HAP.Service.IrrigationSystem.UUID ? null : service.subtype), evetype: "aqua", fields: "1f01 2a08 2302", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);
                    if (service.testCharacteristic(HAP.Characteristic.LockPhysicalControls) == false) service.addCharacteristic(HAP.Characteristic.LockPhysicalControls); // Allows childlock toggle to be displayed in Eve App

                    // Need some internal storage to track Eve Aqua configuration from EveHome app
                    this.EveAquaPersist = {};
                    this.EveAquaPersist.firmware = optionalParams.hasOwnProperty("EveAqua_firmware") ? optionalParams.EveAqua_firmware : 1208; // Firmware version
                    this.EveAquaPersist.flowrate = optionalParams.hasOwnProperty("EveAqua_flowrate") ? optionalParams.EveAqua_flowrate : 18; // 18 L/Min default
                    this.EveAquaPersist.latitude = optionalParams.hasOwnProperty("EveAqua_latitude") ? optionalParams.EveAqua_latitude : 0.0;  // Latitude
                    this.EveAquaPersist.longitude = optionalParams.hasOwnProperty("EveAqua_longitude") ? optionalParams.EveAqua_longitude : 0.0;  // Longitude
                    this.EveAquaPersist.utcoffset = optionalParams.hasOwnProperty("EveAqua_utcoffset") ? optionalParams.EveAqua_utcoffset : (new Date().getTimezoneOffset() * -60);  // UTC offset in seconds
                    this.EveAquaPersist.enableschedule = optionalParams.hasOwnProperty("EveAqua_enableschedule") ? optionalParams.EveAqua_enableschedule : false; // Schedules on/off
                    this.EveAquaPersist.pause = optionalParams.hasOwnProperty("EveAqua_pause") ? optionalParams.EveAqua_pause : 0;  // Day pause 
                    this.EveAquaPersist.programs = optionalParams.hasOwnProperty("EveAqua_programs") ? optionalParams.EveAqua_programs : [];    // Schedules
                
                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveAquaGetDetails(optionalParams.GetCommand));
                    service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).on("get", (callback) => {
                        callback(null, this.#EveAquaGetDetails(optionalParams.GetCommand));
                    });

                    service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).on("set", (value, callback) => {
                        // Loop through set commands passed to us
                        var programs = [];
                        var processedData = {};
                        var valHex = decodeEveData(value);
                        var index = 0;
                        while (index < valHex.length) {
                            // first byte is command in this data stream
                            // second byte is size of data for command
                            var command = valHex.substr(index, 2);
                            var size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                            var data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);
                            switch(command) {
                                case "2e" : {
                                    // flow rate in L/Minute
                                    this.EveAquaPersist.flowrate = Number(((EveHexStringToNumber(data) * 60) / 1000).toFixed(1));
                                    processedData.flowrate = this.EveAquaPersist.flowrate;
                                    break;
                                }

                                case "2f" : {
                                    // reset timestamp in seconds since EPOCH
                                    this.EveAquaPersist.timestamp = (EPOCH_OFFSET + EveHexStringToNumber(data));
                                    processedData.timestamp = this.EveAquaPersist.timestamp;
                                    break;
                                }

                                case "44" : {
                                    // Schedules on/off and Timezone/location information
                                    var subCommand = EveHexStringToNumber(data.substr(2, 4));
                                    this.EveAquaPersist.enableschedule = (subCommand & 0x01) == 0x01;   // Bit 1 is schedule status on/off
                                    if ((subCommand & 0x10) == 0x10) this.EveAquaPersist.utcoffset = EveHexStringToNumber(data.substr(10, 8)) * 60;   // Bit 5 is UTC offset in seconds
                                    if ((subCommand & 0x04) == 0x04) this.EveAquaPersist.latitude = EveHexStringToFloat(data.substr(18, 8), 7);   // Bit 4 is lat/long information 
                                    if ((subCommand & 0x04) == 0x04) this.EveAquaPersist.longitude = EveHexStringToFloat(data.substr(26, 8), 7);  // Bit 4 is lat/long information 
                                    if ((subCommand & 0x02) == 0x02) {
                                        // If bit 2 is set, indicates just a schedule on/off command
                                        processedData.enabled = this.EveAquaPersist.enableschedule;
                                    }
                                    if ((subCommand & 0x02) != 0x02) {
                                        // If bit 2 is not set, this command includes Timezone/location information
                                        processedData.utcoffset = this.EveAquaPersist.utcoffset;
                                        processedData.latitude = this.EveAquaPersist.latitude;
                                        processedData.longitude = this.EveAquaPersist.longitude;
                                    }
                                    break;
                                }

                                case "45" : {
                                    // Eve App Scheduling Programs
                                    var programcount = EveHexStringToNumber(data.substr(2, 2));   // Number of defined programs
                                    var unknown = EveHexStringToNumber(data.substr(4, 6));   // Unknown data for 6 bytes

                                    var index2 = 14;    // Program schedules start at offset 14 in data
                                    var programs = [];
                                    while (index2 < data.length) {
                                        var scheduleSize = parseInt(data.substr(index2 + 2, 2), 16) * 8;
                                        var schedule = data.substring(index2 + 4, index2 + 4 + scheduleSize);
                                    
                                        if (schedule != "") {
                                            var times = [];
                                            for (var index3 = 0; index3 < schedule.length / 8; index3++)
                                            {
                                                // schedules appear to be a 32bit word
                                                // after swapping 16bit words
                                                // 1st 16bits = end time 
                                                // 2nd 16bits = start time
                                                // starttime decode
                                                // bit 1-5 specific time or sunrise/sunset 05 = time, 07 = sunrise/sunset
                                                // if sunrise/sunset
                                                //      bit 6, sunrise = 1, sunset = 0
                                                //      bit 7, before = 1, after = 0
                                                //      bit 8 - 16 - minutes for sunrise/sunset
                                                // if time 
                                                //      bit 6 - 16 - minutes from 00:00
                                                //   
                                                // endtime decode
                                                // bit 1-5 specific time or sunrise/sunset 01 = time, 03 = sunrise/sunset
                                                // if sunrise/sunset
                                                //      bit 6, sunrise = 1, sunset = 0
                                                //      bit 7, before = 1, after = 0
                                                //      bit 8 - 16 - minutes for sunrise/sunset
                                                // if time 
                                                //      bit 6 - 16 - minutes from 00:00
                                                // decode start time
                                                var start = parseInt(schedule.substring((index3 * 8), (index3 * 8) + 4).match(/[a-fA-F0-9]{2}/g).reverse().join(""), 16);
                                                var start_min = null;
                                                var start_hr = null;
                                                var start_offset = null;
                                                var start_sunrise = null;
                                                if ((start & 0x1f) == 5) {
                                                    // specific time
                                                    start_min = (start >>> 5) % 60;   // Start minute
                                                    start_hr = ((start >>> 5) - start_min) / 60;    // Start hour
                                                    start_offset = ((start >>> 5) * 60);    // Seconds since 00:00
                                                } else if ((start & 0x1f) == 7) {
                                                    // sunrise/sunset
                                                    start_sunrise = ((start >>> 5) & 0x01);    // 1 = sunrise, 0 = sunset
                                                    start_offset = ((start >>> 6) & 0x01 ? ~((start >>> 7) * 60) + 1 : (start >>> 7) * 60);   // offset from sunrise/sunset (plus/minus value)
                                                } 
                                    
                                                // decode end time
                                                var end = parseInt(schedule.substring((index3 * 8) + 4, (index3 * 8) + 8).match(/[a-fA-F0-9]{2}/g).reverse().join(""), 16);
                                                var end_min = null;
                                                var end_hr = null;
                                                var end_offset = null;
                                                var end_sunrise = null;
                                                if ((end & 0x1f) == 1) {
                                                    // specific time
                                                    end_min = (end >>> 5) % 60;   // End minute
                                                    end_hr = ((end >>> 5) - end_min) / 60;    // End hour
                                                    end_offset = ((end >>> 5) * 60);    // Seconds since 00:00
                                                } else if ((end & 0x1f) == 3) {
                                                    end_sunrise = ((end >>> 5) & 0x01);    // 1 = sunrise, 0 = sunset
                                                    end_offset = ((end >>> 6) & 0x01 ? ~((end >>> 7) * 60) + 1 : (end >>> 7) * 60);   // offset from sunrise/sunset (plus/minus value)
                                                }
                                                times.push({"start" : (start_sunrise == null ? start_offset : (start_sunrise ? "sunrise" : "sunset")), "duration" : (end_offset - start_offset), "offset": start_offset});
                                            }
                                            programs.push({"id": (programs.length + 1), "days": [], "schedule": times});
                                        }
                                        index2 = index2 + 4 + scheduleSize; // Move to next program
                                    }
                                    break;
                                }

                                case "46" : {
                                    // Eve App active days across programs
                                    //var daynumber = (EveHexStringToNumber(data.substr(8, 6)) >>> 4);
                                
                                    // bit masks for active days mapped to programm id
                                   /* var mon = (daynumber & 0x7);
                                    var tue = ((daynumber >>> 3) & 0x7)
                                    var wed = ((daynumber >>> 6) & 0x7)
                                    var thu = ((daynumber >>> 9) & 0x7)
                                    var fri = ((daynumber >>> 12) & 0x7)
                                    var sat = ((daynumber >>> 15) & 0x7)
                                    var sun = ((daynumber >>> 18) & 0x7) */
                                    var unknown = EveHexStringToNumber(data.substr(0, 6));   // Unknown data for first 6 bytes
                                    var daysbitmask = (EveHexStringToNumber(data.substr(8, 6)) >>> 4);
                                    programs.forEach(program => {
                                        for (var index2 = 0; index2 < DAYSOFWEEK.length; index2++) {
                                            if (((daysbitmask >>> (index2 * 3)) & 0x7) == program.id) {
                                                program.days.push(DAYSOFWEEK[index2]);
                                            }
                                        }
                                    });

                                    processedData.programs = programs;
                                    break;
                                }

                                case "47" : {
                                    // Eve App DST information
                                    this.EveAquaPersist.command47 = command + valHex.substr(index + 2, 2) + data;
                                    break;
                                }

                                case "4b" : {
                                    // Eve App suspension scene triggered from HomeKit
                                    this.EveAquaPersist.pause = (EveHexStringToNumber(data.substr(0, 8)) / 1440) + 1; // 1440 mins in a day. Zero based day, so we add one
                                    processedData.pause = this.EveAquaPersist.pause;
                                    break;
                                }

                                case "b1" : {
                                    // Child lock on/off. Seems data packet is always same (0100), so inspect "HAP.Characteristic.LockPhysicalControls)" for actual status
                                    this.EveAquaPersist.childlock = (service.getCharacteristic(HAP.Characteristic.LockPhysicalControls).value == HAP.Characteristic.CONTROL_LOCK_ENABLED ? true : false);
                                    processedData.childlock = this.EveAquaPersist.childlock;
                                    break;
                                }

                                default : {
                                    this.#outputLogging("History", true,  "Unknown Eve Aqua command '%s' with data '%s'", command, data);
                                    break;
                                }
                            }
                            index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                        };

                        // Send complete processed command data if configured to our callback
                        if (typeof optionalParams.SetCommand == "function" && Object.keys(processedData).length != 0) optionalParams.SetCommand(processedData);
                        callback();
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Aqua");
                    break;
                }

                case HAP.Service.Outlet.UUID : {
                    // treat these as EveHome energy
                    // TODO - schedules
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);  
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
            
                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "energy", fields: "0702 0e01", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                    service.addCharacteristic(HAP.Characteristic.EveFirmware);
                    service.addCharacteristic(HAP.Characteristic.EveElectricalVoltage);
                    service.addCharacteristic(HAP.Characteristic.EveElectricalCurrent);
                    service.addCharacteristic(HAP.Characteristic.EveElectricalWattage);
                    service.addCharacteristic(HAP.Characteristic.EveTotalConsumption);

                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveFirmware, encodeEveData(util.format("29 %s be", numberToEveHexString(807, 4))));  // firmware version (build xxxx)));

                    service.updateCharacteristic(HAP.Characteristic.EveElectricalCurrent, this.#EveEnergyGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveElectricalCurrent));
                    service.getCharacteristic(HAP.Characteristic.EveElectricalCurrent).on("get", (callback) => {
                        callback(null, this.#EveEnergyGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveElectricalCurrent));
                    });

                    service.updateCharacteristic(HAP.Characteristic.EveElectricalVoltage, this.#EveEnergyGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveElectricalVoltage));
                    service.getCharacteristic(HAP.Characteristic.EveElectricalVoltage).on("get", (callback) => {
                        callback(null, this.#EveEnergyGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveElectricalVoltage));
                    });

                    service.updateCharacteristic(HAP.Characteristic.EveElectricalWattage, this.#EveEnergyGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveElectricalWattage));
                    service.getCharacteristic(HAP.Characteristic.EveElectricalWattage).on("get", (callback) => {
                        callback(null, this.#EveEnergyGetDetails(optionalParams.GetCommand, HAP.Characteristic.EveElectricalWattage));
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Energy");
                    break;
                }


                case HAP.Service.LeakSensor.UUID : {
                    // treat these as EveHome Water Guard
                    var historyService = HomeKitAccessory.addService(HAP.Service.EveHomeHistory, "", 1);
                    var tempHistory = this.getHistory(service.UUID, service.subtype);
                    var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                    service.addCharacteristic(HAP.Characteristic.EveGetConfiguration);
                    service.addCharacteristic(HAP.Characteristic.EveSetConfiguration);

                    if (service.testCharacteristic(HAP.Characteristic.StatusFault) == false) service.addCharacteristic(HAP.Characteristic.StatusFault);

                    // <---- Still need to detwermin signature fields
                    this.EveHome = {service: historyService, linkedservice: service, type: service.UUID, sub: service.subtype, evetype: "waterguard", fields: "xxxx", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};

                    // Need some internal storage to track Eve Water Guard configuration from EveHome app
                    this.EveWaterGuardPersist = {};
                    this.EveWaterGuardPersist.firmware = optionalParams.hasOwnProperty("EveWaterGuard_firmware") ? optionalParams.EveWaterGuard_firmware : 2866; // Firmware version
                    this.EveWaterGuardPersist.lastalarmtest = optionalParams.hasOwnProperty("EveWaterGuard_lastalarmtest") ? optionalParams.EveWaterGuard_lastalarmtest : 0; // Time in seconds of alarm test
                    this.EveWaterGuardPersist.muted = optionalParams.hasOwnProperty("EveWaterGuard_muted") ? optionalParams.EveWaterGuard_muted : false;    // Leak alarms are not muted
                
                    // Setup initial values and callbacks for charateristics we are using
                    service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveWaterGuardGetDetails(optionalParams.GetCommand));
                    service.getCharacteristic(HAP.Characteristic.EveGetConfiguration).on("get", (callback) => {
                        callback(null, this.#EveWaterGuardGetDetails(optionalParams.GetCommand));
                    });

                    service.getCharacteristic(HAP.Characteristic.EveSetConfiguration).on("set", (value, callback) => {
                        var valHex = decodeEveData(value);
                        var index = 0;
                        while (index < valHex.length) {
                            // first byte is command in this data stream
                            // second byte is size of data for command
                            var command = valHex.substr(index, 2);
                            var size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                            var data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);

                            console.log(command, data)
                            switch(command) {
                                case "4d" : {
                                    // Alarm test
                                    // b4 - start
                                    // 00 - finished
                                    break;
                                }

                                case "4e" : {
                                    // Mute alarm
                                    // 00 - unmute alarm
                                    // 01 - mute alarm
                                    // 03 - alarm test
                                    if (data == "03") {
                                        // Simulate a leak test
                                        service.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_DETECTED);
                                        this.EveWaterGuardPersist.lastalarmtest = Math.floor(Date.now() / 1000);    // Now time for last test
                                       
                                        setTimeout(() => {         
                                            // Clear our simulated leak test after 5 seconds
                                            service.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
                                        }, 5000);
                                    }
                                    if (data == "00" || data == "01") {
                                        this.EveWaterGuardPersist.muted = (data == "01" ? true : false);
                                    }
                                    break;
                                }

                                default : {
                                    this.#outputLogging("History", true,  "Unknown Eve Water Guard command '%s' with data '%s'", command, data);
                                    break;
                                }
                            }
                            index += (4 + size);  // Move to next command accounting for header size of 4 bytes
                        };
                        callback();
                    });

                    this.#outputLogging("History", false, "History linked to EveHome app as '%s'", "Eve Water Guard");
                    break;
                }
            }
        
            // Setup callbacks if our service successfully created
            if (typeof this.EveHome == "object" && this.EveHome.hasOwnProperty("service") == true) {
                this.EveHome.service.getCharacteristic(HAP.Characteristic.EveResetTotal).on("get", (callback) => {callback(null, this.historyData.reset - EPOCH_OFFSET)});   // time since history reset
                this.EveHome.service.getCharacteristic(HAP.Characteristic.EveHistoryStatus).on("get", this.#EveHistoryStatus.bind(this));
                this.EveHome.service.getCharacteristic(HAP.Characteristic.EveHistoryEntries).on("get", this.#EveHistoryEntries.bind(this));
                this.EveHome.service.getCharacteristic(HAP.Characteristic.EveHistoryRequest).on("set", this.#EveHistoryRequest.bind(this));
                this.EveHome.service.getCharacteristic(HAP.Characteristic.EveSetTime).on("set", this.#EveSetTime.bind(this));

                return this.EveHome.service;    // Return service handle for our EveHome accessory service
            }
        }
    }

    updateEveHome(service, GetCommand) {
        if (typeof this.EveHome != "object" || this.EveHome.hasOwnProperty("service") == false || typeof GetCommand != "function") {
            return;
        }

        switch (service.UUID) {
            case HAP.Service.SmokeSensor.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveDeviceStatus, this.#EveSmokeGetDetails(GetCommand, HAP.Characteristic.EveDeviceStatus));
                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveSmokeGetDetails(GetCommand, HAP.Characteristic.EveGetConfiguration));
                break;
            }

            case HAP.Service.HeaterCooler.UUID :
            case HAP.Service.Thermostat.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveProgramCommand, this.#EveThermoGetDetails(GetCommand));
                break;
            }

            case HAP.Service.Valve.UUID :
            case HAP.Service.IrrigationSystem.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveGetConfiguration, this.#EveAquaGetDetails(GetCommand));
                break;
            }

            case HAP.Service.Outlet.UUID : {
                service.updateCharacteristic(HAP.Characteristic.EveElectricalWattage, this.#EveEnergyGetDetails(GetCommand, HAP.Characteristic.EveElectricalWattage));
                service.updateCharacteristic(HAP.Characteristic.EveElectricalVoltage, this.#EveEnergyGetDetails(GetCommand, HAP.Characteristic.EveElectricalVoltage));
                service.updateCharacteristic(HAP.Characteristic.EveElectricalCurrent, this.#EveEnergyGetDetails(GetCommand, HAP.Characteristic.EveElectricalCurrent));
                break;
            }
        }        
    }

    #EveLastEventTime() {
        // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
        var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
        var lastTime = Math.floor(new Date() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
        if (historyEntry && Object.keys(historyEntry).length != 0) {
            lastTime -= (Math.floor(new Date() / 1000) - historyEntry.time);
        }
        return lastTime;
    }

    #EveThermoGetDetails(optionGetFunction) {
        // returns an encoded value formatted for an Eve Thermo device 
        //
        // TODO - before enabling below need to workout:
        //          - mode graph to show
        //          - temperature unit setting
        //          - thermo 2020??
        //
        // commands
        // 11 - valve protection on/off - TODO
        // 12 - temp offset
        // 13 - schedules enabled/disabled
        // 16 - Window/Door open status
        //          100000 - open
        //          000000 - close
        // 14 - installation status
        //          c0,c8 = ok
        //          c1,c6,c9 = in-progress
        //          c2,c3,c4,c5 = error on removal
        //          c7 = not attached
        // 19 - vacation mode
        //          00ff - off
        //          01 + "away temp" - enabled with vacation temp
        // f4 - temperatures
        // fa - programs for week
        // fc - date/time (mmhhDDMMYY)
        // 1a - default day program??

        if (typeof optionGetFunction == "function") this.EveThermoPersist = optionGetFunction(this.EveThermoPersist); // Fill in details we might want to be dynamic

        // Encode the temperature offset into an unsigned value
        var tempOffset = this.EveThermoPersist.tempoffset * 10;
        if (tempOffset < 127) {
            tempOffset = tempOffset + 256;
        }

        // Encode date/time
        var tempDateTime = this.EveThermoPersist.datetime;
        if (typeof this.EveThermoPersist.datetime == "object") {
            tempDateTime = this.EveThermoPersist.datetime.getMinutes().toString(16).padStart(2, "0") + this.EveThermoPersist.datetime.getHours().toString(16).padStart(2, "0") + this.EveThermoPersist.datetime.getDate().toString(16).padStart(2, "0") + (this.EveThermoPersist.datetime.getMonth() + 1).toString(16).padStart(2, "0") + parseInt(this.EveThermoPersist.datetime.getFullYear().toString().substr(-2)).toString(16).padStart(2, "0");
        }

        // Encode program schedule and temperatures
        // f4 = temps
        // fa = schedule
        const EMPTYSCHEDULE = "ffffffffffffffff";
        var encodedSchedule = [EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE, EMPTYSCHEDULE];
        var encodedTemperatures = "0000";
        if (typeof this.EveThermoPersist.programs == "object") {
            var tempTemperatures = [];
            Object.entries(this.EveThermoPersist.programs).forEach(([id, days]) => {
                var temp = "";
                days.schedule.forEach(time => {
                    temp = temp + numberToEveHexString(Math.round(time.start / 600), 2) + numberToEveHexString(Math.round((time.start + time.duration) / 600), 2);
                    tempTemperatures.push(time.ecotemp, time.comforttemp);
                });
                encodedSchedule[DAYSOFWEEK.indexOf(days.days.toLowerCase())] = temp.substring(0, EMPTYSCHEDULE.length) + EMPTYSCHEDULE.substring(temp.length, EMPTYSCHEDULE.length);
            });
            var ecoTemp = tempTemperatures.length == 0 ? 0 : Math.min(...tempTemperatures);
            var comfortTemp = tempTemperatures.length == 0 ? 0 : Math.max(...tempTemperatures);
            encodedTemperatures = numberToEveHexString((ecoTemp / 0.5), 2) + numberToEveHexString((comfortTemp / 0.5), 2);
        }

        var value = util.format(
            "12%s 13%s 14%s 19%s fc%s f40000%s fa%s",
            numberToEveHexString(tempOffset, 2),
            this.EveThermoPersist.enableschedule == true ? "01" : "00",
            this.EveThermoPersist.attached = this.EveThermoPersist.attached == true ? "c0" : "c7",
            this.EveThermoPersist.vacation == true ? "01" + numberToEveHexString(this.EveThermoPersist.vacationtemp * 2, 2) : "00ff", // away status and temp
            numberToEveHexString(tempDateTime, 6),
            encodedTemperatures,
            encodedSchedule[0] + encodedSchedule[1] + encodedSchedule[2] + encodedSchedule[3] + encodedSchedule[4] + encodedSchedule[5] + encodedSchedule[6]);

         return encodeEveData(value);
    }

    #EveAquaGetDetails(optionGetFunction) {
        // returns an encoded value formatted for an Eve Aqua device for water usage and last water time
        if (typeof optionGetFunction == "function") this.EveAquaPersist = optionGetFunction(this.EveAquaPersist); // Fill in details we might want to be dynamic

        if (Array.isArray(this.EveAquaPersist.programs) == false) {
            // Ensure any program information is an array
            this.EveAquaPersist.programs = [];
        }

        var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

        // Calculate total water usage over history period
        var totalWater = 0;
        tempHistory.forEach(historyEntry => {
            if (historyEntry.status == 0) {
                // add to total water usage if we have a valve closed event
                totalWater += parseFloat(historyEntry.water);
            }
        });

        // Encode program schedule
        // 45 = schedules
        // 46 = days of weeks for schedule;
        const EMPTYSCHEDULE = "0800";
        var encodedSchedule = "";
        var daysbitmask = 0;
        var temp45Command = "";
        var temp46Command = "";

        this.EveAquaPersist.programs.forEach((program) => {
            var tempEncodedSchedule = "";
            program.schedule.forEach((schedule) => {
                // Encode absolute time (ie: not sunrise/sunset one)
                if (typeof schedule.start == "number") {
                    tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.start / 60) << 5) + 0x05, 4);
                    tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.start + schedule.duration) / 60) << 5) + 0x01, 4);
                }
                if (typeof schedule.start == "string" && schedule.start == "sunrise") {
                    if (schedule.offset < 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((Math.abs(schedule.offset) / 60) << 7) + 0x67, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((Math.abs(schedule.offset) + schedule.duration) / 60) << 7) + 0x63, 4);
                    }
                    if (schedule.offset >= 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.offset / 60) << 7) + 0x27, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.offset + schedule.duration) / 60) << 7) + 0x23, 4);
                    }
                }
                if (typeof schedule.start == "string" && schedule.start == "sunset") {
                    if (schedule.offset < 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((Math.abs(schedule.offset) / 60) << 7) + 0x47, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((Math.abs(schedule.offset) + schedule.duration) / 60) << 7) + 0x43, 4);
                    }
                    if (schedule.offset >= 0) {
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.offset / 60) << 7) + 0x07, 4);
                        tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.offset + schedule.duration) / 60) << 7) + 0x03, 4);
                    }
                }
            });
            encodedSchedule = encodedSchedule + numberToEveHexString((tempEncodedSchedule.length / 8) < 2 ? 10 : 11, 2) + numberToEveHexString(tempEncodedSchedule.length / 8, 2) + tempEncodedSchedule;

            // Encode days for this program
            // Program ID is set in 3bit repeating sections
            // sunsatfrithuwedtuemon
            program.days.forEach((day) => {
                daysbitmask = daysbitmask + (program.id << (DAYSOFWEEK.indexOf(day) * 3));
            });
        });

        // Build the encoded schedules command to send back to Eve
        temp45Command = "05" + numberToEveHexString(this.EveAquaPersist.programs.length + 1, 2) + "000000" + EMPTYSCHEDULE + encodedSchedule;
        temp45Command = "45" + numberToEveHexString(temp45Command.length / 2, 2) + temp45Command;

        // Build the encoded days command to send back to Eve
        // 00000 appears to always be 1b202c??
        temp46Command = "05" + "000000" + numberToEveHexString((daysbitmask << 4) + 0x0f, 6);
        temp46Command = temp46Command.padEnd((daysbitmask == 0 ? 18 : 168), "0");   // Pad the command out to Eve's lengths 
        temp46Command = "46" + numberToEveHexString(temp46Command.length / 2, 2) + temp46Command;

        var value = util.format(
            "0002 2300 0302 %s d004 %s 9b04 %s 2f0e %s 2e02 %s 441105 %s%s%s%s %s %s %s 0000000000000000 1e02 2300 0c",
            numberToEveHexString(this.EveAquaPersist.firmware, 4),  // firmware version (build xxxx)
            numberToEveHexString(tempHistory.length != 0 ? tempHistory[tempHistory.length - 1].time : 0, 8),  // time of last event, 0 if never watered
            numberToEveHexString(Math.floor(new Date() / 1000), 8), // "now" time
            numberToEveHexString(Math.floor(totalWater * 1000), 20), // total water usage in ml (64bit value)
            numberToEveHexString(Math.floor((this.EveAquaPersist.flowrate * 1000) / 60), 4), // water flow rate (16bit value)
            numberToEveHexString(this.EveAquaPersist.enableschedule == true ? parseInt("10111", 2) : parseInt("10110", 2), 8),
            numberToEveHexString(Math.floor(this.EveAquaPersist.utcoffset / 60), 8),
            floatToEveHexString(this.EveAquaPersist.latitude, 8),
            floatToEveHexString(this.EveAquaPersist.longitude, 8),
            (this.EveAquaPersist.pause != 0 ? "4b04" + numberToEveHexString((this.EveAquaPersist.pause - 1) * 1440, 8) : ""),
            temp45Command, 
            temp46Command);

        return encodeEveData(value);
    };

    #EveEnergyGetDetails(optionGetFunction, returnForCharacteristic) {
        var energyDetails = {};
        var returnValue = null;

        if (typeof optionGetFunction == "function") energyDetails = optionGetFunction(energyDetails); // Fill in details we might want to be dynamic

        if (returnForCharacteristic.UUID == HAP.Characteristic.EveElectricalWattage.UUID && energyDetails.hasOwnProperty("watts") == true && typeof energyDetails.watts == "number") {
            returnValue = energyDetails.watts;
        }
        if (returnForCharacteristic.UUID == HAP.Characteristic.EveElectricalVoltage.UUID && energyDetails.hasOwnProperty("volts") == true && typeof energyDetails.volts == "number") {
            returnValue = energyDetails.volts;
        }
        if (returnForCharacteristic.UUID == HAP.Characteristic.EveElectricalCurrent.UUID && energyDetails.hasOwnProperty("amps") == true && typeof energyDetails.amps == "number") {
            returnValue = energyDetails.amps;
        }

        return returnValue;
    }

    #EveSmokeGetDetails(optionGetFunction, returnForCharacteristic) {
        // returns an encoded value formatted for an Eve Smoke device 
        var returnValue = null;

        if (typeof optionGetFunction == "function") this.EveSmokePersist = optionGetFunction(this.EveSmokePersist); // Fill in details we might want to be dynamic

        if (returnForCharacteristic.UUID == HAP.Characteristic.EveGetConfiguration.UUID) {
            var value = util.format(
                "0002 1800 0302 %s 9b04 %s 8608 %s 1e02 1800 0c",
                numberToEveHexString(this.EveSmokePersist.firmware, 4),  // firmware version (build xxxx)
                numberToEveHexString(Math.floor(new Date() / 1000), 8), // "now" time
                numberToEveHexString(this.EveSmokePersist.lastalarmtest, 8));    // Not sure why 64bit value???
            returnValue = encodeEveData(value);
        }

        if (returnForCharacteristic.UUID == HAP.Characteristic.EveDeviceStatus.UUID) {
            // Status bits
            //  0 = Smoked Detected
            //  1 = Heat Detected
            //  2 = Alarm test active
            //  5 = Smoke sensor error
            //  6 = Heat sensor error
            //  7 = Sensor error??
            //  9 = Smoke chamber error
            // 14 = Smoke sensor deactivated
            // 15 = flash status led (on)
            // 24 & 25 = alarms paused
            // 25 = alarm muted
            var value = 0x00000000;
            if (this.EveHome.linkedservice.getCharacteristic(HAP.Characteristic.SmokeDetected).value == HAP.Characteristic.SmokeDetected.SMOKE_DETECTED) value |= (1 << 0);  // 1st bit, smoke detected
            if (this.EveSmokePersist.heatstatus != 0) value |= (1 << 1);    // 2th bit - heat detected
            if (this.EveSmokePersist.alarmtest == true) value |= (1 << 2);    // 4th bit - alarm test running
            if (this.EveSmokePersist.smoketestpassed == false) value |= (1 << 5);   // 5th bit - smoke test OK
            if (this.EveSmokePersist.heattestpassed == false) value |= (1 << 6);   // 6th bit - heat test OK
            if (this.EveSmokePersist.smoketestpassed == false) value |= (1 << 9);   // 9th bit - smoke test OK
            if (this.EveSmokePersist.statusled == true) value |= (1 << 15);   // 15th bit - flash status led
            if (this.EveSmokePersist.hushedstate == true) value |= (1 << 25);    // 25th bit, alarms muted

            returnValue = value >>> 0;  // Ensure UINT32
        }
        return returnValue;
    };

    #EveWaterGuardGetDetails(optionGetFunction) {
        // returns an encoded value formatted for an Eve Water Guard
        if (typeof optionGetFunction == "function") this.EveWaterGuardPersist = optionGetFunction(this.EveWaterGuardPersist); // Fill in details we might want to be dynamic

        var value = util.format(
            "0002 5b00 0302 %s 9b04 %s 8608 %s 4e01 %s %s 1e02 5b00 0c",
            numberToEveHexString(this.EveWaterGuardPersist.firmware, 4),  // firmware version (build xxxx)
            numberToEveHexString(Math.floor(new Date() / 1000), 8), // "now" time
            numberToEveHexString(this.EveWaterGuardPersist.lastalarmtest, 8),    // Not sure why 64bit value???
            numberToEveHexString(this.EveWaterGuardPersist.muted == true ? 1 : 0, 2));    // Alarm mute status
        return encodeEveData(value);
    };

    #EveHistoryStatus(callback) {
        var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing
        var historyTime = (tempHistory.length == 0 ? Math.floor(new Date() / 1000) : tempHistory[tempHistory.length - 1].time);
        this.EveHome.reftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
        this.EveHome.count = tempHistory.length;    // Number of history entries for this type

        var value = util.format(
            "%s 00000000 %s %s %s %s %s %s 000000000101",
            numberToEveHexString(historyTime - this.EveHome.reftime - EPOCH_OFFSET, 8),
            numberToEveHexString(this.EveHome.reftime, 8), // reference time (time of first history??)
            numberToEveHexString(this.EveHome.fields.trim().match(/\S*[0-9]\S*/g).length, 2), // Calclate number of fields we have
            this.EveHome.fields.trim(),    // Fields listed in string. Each field is seperated by spaces
            numberToEveHexString(this.EveHome.count, 4), // count of entries
            numberToEveHexString(this.maxEntries == 0 ? MAX_HISTORY_SIZE : this.maxEntries, 4),  // history max size
            numberToEveHexString(1, 8));  // first entry
            
        callback(null, encodeEveData(value));
        // this.#outputLogging("History", true,  "#EveHistoryStatus: history for '%s:%s' (%s) - Entries %s", this.EveHome.type, this.EveHome.sub, this.EveHome.evetype, this.EveHome.count);
    }

    #EveHistoryEntries(callback) {
        // Streams our history data back to EveHome when requested
        var dataStream = "";
        if (this.EveHome.entry <= this.EveHome.count && this.EveHome.send != 0) {
            var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

            // Generate eve home history header for data following
            var data = util.format(
                "%s 0100 0000 81 %s 0000 0000 00 0000",
                numberToEveHexString(this.EveHome.entry, 8),
                numberToEveHexString(this.EveHome.reftime, 8));

            // Format the data string, including calculating the number of "bytes" the data fits into
            data = data.replace(/ /g, "");
            dataStream += util.format("%s %s", (data.length / 2 + 1).toString(16), data);

            for (var i = 0; i < EVEHOME_MAX_STREAM; i++) {
                if (tempHistory.length != 0 && (this.EveHome.entry - 1) <= tempHistory.length) {
                    var historyEntry = tempHistory[this.EveHome.entry - 1]; // need to map EveHome entry address to our data history, as EvenHome addresses start at 1
                    var data = util.format(
                        "%s %s",
                        numberToEveHexString(this.EveHome.entry, 8),
                        numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8));  // Create the common header data for eve entry

                    switch (this.EveHome.evetype) {
                        case "aqua" : {
                            // 1f01 2a08 2302
                            // 1f - InUse
                            // 2a - Water Usage (ml)
                            // 23 - Battery millivolts
                            data += util.format(
                                "%s %s %s %s",
                                numberToEveHexString((historyEntry.status == 0 ? parseInt("111", 2) : parseInt("101", 2)), 2),   // Field mask, 111 is for sending water usage when a valve is recorded as closed, 101 is for when valve is recorded as opened, no water usage is sent
                                numberToEveHexString(historyEntry.status, 2),
                                (historyEntry.status == 0 ? numberToEveHexString(Math.floor(parseFloat(historyEntry.water) * 1000), 16) : ""),   // water used in millilitres if valve closed entry (64bit value)
                                numberToEveHexString(3120, 4)); // battery millivolts - 3120mv which think should be 100% for an eve aqua running on 2 x AAs??
                            break;
                        }

                        case "room" : {
                            // 0102 0202 0402 0f03
                            // 01 - Temperature
                            // 02 - Humidity
                            // 04 - Air Quality (ppm)
                            // 0f - VOC Heat Sense??
                            data += util.format(
                                "%s %s %s %s %s",
                                numberToEveHexString(parseInt("1111", 2), 2), // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(historyEntry.hasOwnProperty("ppm") ? historyEntry.ppm * 10 : 10, 4), // PPM - air quality
                                numberToEveHexString(0, 6));    // VOC??
                            break;
                        }

                        case "room2" : {
                            // 0102 0202 2202 2901 2501 2302 2801
                            // 01 - Temperature
                            // 02 - Humidity
                            // 22 - VOC Density (ppb)
                            // 29 - ??
                            // 25 - Battery level %
                            // 23 - Battery millivolts
                            // 28 - ??
                            data += util.format(
                                "%s %s %s %s %s %s %s %s",
                                numberToEveHexString(parseInt("1111111", 2), 2),   // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(historyEntry.hasOwnProperty("voc") ? historyEntry.voc : 0, 4), // VOC - air quality in ppm
                                numberToEveHexString(0, 2), // ??
                                numberToEveHexString(100, 2), // battery level % - 100%
                                numberToEveHexString(4771, 4), // battery millivolts - 4771mv
                                numberToEveHexString(1, 2));    // ??
                            break;
                        }

                        case "weather" : {
                            // 0102 0202 0302
                            // 01 - Temperature
                            // 02 - Humidity
                            // 03 - Air Pressure
                            data += util.format(
                                "%s %s %s %s",
                                numberToEveHexString(parseInt("111", 2), 2),   // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(historyEntry.hasOwnProperty("pressure") ? historyEntry.pressure * 10 : 10, 4)); // Pressure
                            break;
                        }

                        case "motion" : {
                            // 1301 1c01
                            // 13 - Motion detected
                            // 1c - Motion currently active??
                            data += util.format(
                                "%s %s",
                                numberToEveHexString(parseInt("10", 2), 2),    // Field include/exclude mask
                                numberToEveHexString(historyEntry.status, 2));
                            break;
                        }

                        case "contact" : 
                        case "switch" : {
                            // contact, motion and switch sensors treated the same for status
                            // 0601
                            // 06 - Contact status 0 = no contact, 1 = contact
                            data += util.format(
                                "%s %s",
                                numberToEveHexString(parseInt("1", 2), 2), // Field include/exclude mask
                                numberToEveHexString(historyEntry.status, 2));
                            break;
                        }

                        case "door" : {
                            // Invert status for EveHome. As EveHome door is a contact sensor, where 1 is contact and 0 is no contact, opposite of what we expect a door to be
                            // ie: 0 = closed, 1 = opened
                            // 0601
                            // 06 - Contact status 0 = no contact, 1 = contact
                            data += util.format(
                                "%s %s",
                                numberToEveHexString(parseInt("1", 2), 2), // Field include/exclude mask
                                numberToEveHexString(historyEntry.status == 1 ? 0 : 1, 2));  // status for EveHome (inverted ie: 1 = closed, 0 = opened) */
                            break;
                        }

                        case "thermo" : {
                            // 0102 0202 1102 1001 1201 1d01
                            // 01 - Temperature
                            // 02 - Humidity
                            // 11 - Target Temperature
                            // 10 - Valve percentage
                            // 12 - Thermo target
                            // 1d - Open window
                            var tempTarget = 0;
                            if (typeof historyEntry.target == "object") {
                                if (historyEntry.target.low == 0 && historyEntry.target.high != 0) tempTarget = historyEntry.target.high;   // heating limit
                                if (historyEntry.target.low != 0 && historyEntry.target.high != 0) tempTarget = historyEntry.target.high;   // range, so using heating limit
                                if (historyEntry.target.low != 0 && historyEntry.target.high == 0) tempTarget = 0;   // cooling limit
                                if (historyEntry.target.low == 0 && historyEntry.target.high == 0) tempTarget = 0;   // off
                            }

                            data += util.format(
                                "%s %s %s %s %s %s %s",
                                numberToEveHexString(parseInt("111111", 2), 2),    // Field include/exclude mask
                                numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                                numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                                numberToEveHexString(tempTarget * 100, 4), // target temperature for heating
                                numberToEveHexString(historyEntry.status == 2 ? 100 : historyEntry.status == 3 ? 50 : 0, 2), // 0% valve position = off, 50% = cooling, 100% = heating
                                numberToEveHexString(0, 2), // Thermo target
                                numberToEveHexString(0, 2)); // Window open status 0 = window closed, 1 = open
                            break;
                        }

                        case "energy" : {
                            // 0702 0e01
                            // 07 - Power10thWh
                            // 0e - on/off
                            data += util.format(
                                "%s %s %s",
                                numberToEveHexString(parseInt("11", 2), 2),    // Field include/exclude mask
                                numberToEveHexString(historyEntry.watts * 10, 4),   // Power in watts
                                numberToEveHexString(historyEntry.status, 2));  // Power status, 1 = on, 0 = off
                            break;
                        }

                        case "smoke" : {
                            // TODO - What do we send back??
                            console.log("smoke history");
                            break;
                        }
                                
                        case "blind" : {
                            // TODO - What do we send back??
                            console.log("blinds history");
                            break;
                        }

                        case "waterguard" : {
                            // TODO - What do we send back??
                            console.log("water guard history");
                            break;
                        }
                    }

                    // Format the data string, including calculating the number of "bytes" the data fits into
                    data = data.replace(/ /g, "");
                    dataStream += util.format("%s%s", numberToEveHexString(data.length / 2 + 1, 2), data);
                
                    this.EveHome.entry++;    
                    if (this.EveHome.entry > this.EveHome.count) break;
                }
            }
            if (this.EveHome.entry > this.EveHome.count) {
                // No more history data to send back
                // this.#outputLogging("History", true,  "#EveHistoryEntries: sent '%s' entries to EveHome ('%s') for '%s:%s'", this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub);
                this.EveHome.send = 0;  // no more to send
                dataStream += "00";
            }
        } else {
            // We're not transferring any data back
            // this.#outputLogging("History", true,  "#EveHistoryEntries: do we ever get here.....???", this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub, this.EveHome.entry);
            this.EveHome.send = 0;  // no more to send
            dataStream = "00";
        }
        callback(null, encodeEveData(dataStream));
    }

    #EveHistoryRequest(value, callback) {
        // Requesting history, starting at specific entry
        this.EveHome.entry = EveHexStringToNumber(decodeEveData(value).substring(4, 12));    // Starting entry
        if (this.EveHome.entry == 0) {
            this.EveHome.entry = 1; // requested to restart from beginning of history for sending to EveHome
        }
        this.EveHome.send = (this.EveHome.count - this.EveHome.entry + 1);    // Number of entries we're expected to send
        callback();
        // this.#outputLogging("History", true,  "#EveHistoryRequest: requested address", this.EveHome.entry);
    }

    #EveSetTime(value, callback) {
        // Time stamp from EveHome
        var timestamp = (EPOCH_OFFSET + EveHexStringToNumber(decodeEveData(value)));
        callback();
        // this.#outputLogging("History", true,  "#EveSetTime: timestamp offset", new Date(timestamp * 1000));
    }

    #outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
        var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
        if (useConsoleDebug == false) {
            console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
        }
        if (useConsoleDebug == true) {
            console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
        }
    }
}


// General functions
function encodeEveData(string) {
    return Buffer.from(("" + string).replace(/[^a-fA-F0-9]/ig, ""), "hex").toString("base64");
}

function decodeEveData(data) {
    if (typeof data != "string") return data;
    return Buffer.from(data, "base64").toString("hex");
}

// Converts a integer number into a string for EveHome, including formatting to byte width and reverse byte order
// handles upto 128bit values
function numberToEveHexString(number, bytes) {
    if (typeof number != "number" || bytes > 32) {
        return number;
    }
    var tempString = "00000000000000000000000000000000" + Math.floor(number).toString(16);
    tempString = tempString.slice(-1 * bytes).match(/[a-fA-F0-9]{2}/g).reverse().join("");
    return tempString;
}

// Converts a float number into a string for EveHome, including formatting to byte width and reverse byte order
// handles upto 128bit values
function floatToEveHexString(number, bytes) {
    if (typeof number != "number" || bytes > 32) {
        return number;
    }
    var buf = Buffer.allocUnsafe(4);
    buf.writeFloatBE(number, 0);
    var tempString = "00000000000000000000000000000000" + buf.toString("hex");
    tempString = tempString.slice(-1 * bytes).match(/[a-fA-F0-9]{2}/g).reverse().join("");
    return tempString;
}

// Converts Eve encoded hex string to number
function EveHexStringToNumber(string) {
    if (typeof string != "string") return string;
    var tempString = string.match(/[a-fA-F0-9]{2}/g).reverse().join("");
    return Number(parseInt(tempString, 16));   // convert to number on return
}

// Converts Eve encoded hex string to floating number with optional precision for result
function EveHexStringToFloat(string, precision) {
    if (typeof string != "string") return string;
    var tempString = string.match(/[a-fA-F0-9]{2}/g).reverse().join("");
    var float = Buffer.from(tempString, "hex").readFloatBE(0);
    return Number((precision != 0) ? float.toFixed(precision) : float);
}


// Define HomeKit characteristics

// Eve Reset Total
HAP.Characteristic.EveResetTotal = function() {
	HAP.Characteristic.call(this, "Eve Reset Total", "E863F112-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT32,
        unit: HAP.Characteristic.Units.SECONDS, // since 2001/01/01
		perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY, HAP.Characteristic.Perms.WRITE]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveResetTotal, HAP.Characteristic);
HAP.Characteristic.EveResetTotal.UUID = "E863F112-079E-48FF-8F27-9C2605A29F52";

// EveHistoryStatus
HAP.Characteristic.EveHistoryStatus = function() {
	HAP.Characteristic.call(this, "Eve History Status", "E863F116-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
		perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY, HAP.Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveHistoryStatus, HAP.Characteristic);
HAP.Characteristic.EveHistoryStatus.UUID = "E863F116-079E-48FF-8F27-9C2605A29F52";

// EveHistoryEntries
HAP.Characteristic.EveHistoryEntries = function() {
	HAP.Characteristic.call(this, "Eve History Entries", "E863F117-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
		perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY, HAP.Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveHistoryEntries, HAP.Characteristic);
HAP.Characteristic.EveHistoryEntries.UUID = "E863F117-079E-48FF-8F27-9C2605A29F52";

// EveHistoryRequest
HAP.Characteristic.EveHistoryRequest = function() {
	HAP.Characteristic.call(this, "Eve History Request", "E863F11C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
		perms: [HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveHistoryRequest, HAP.Characteristic);
HAP.Characteristic.EveHistoryRequest.UUID = "E863F11C-079E-48FF-8F27-9C2605A29F52";

// EveSetTime
HAP.Characteristic.EveSetTime = function() {
	HAP.Characteristic.call(this, "Eve SetTime", "E863F121-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
		perms: [HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveSetTime, HAP.Characteristic);
HAP.Characteristic.EveSetTime.UUID = "E863F121-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveValvePosition = function() {
	HAP.Characteristic.call(this, "Eve Valve Position", "E863F12E-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        unit: HAP.Characteristic.Units.PERCENTAGE,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveValvePosition, HAP.Characteristic);
HAP.Characteristic.EveValvePosition.UUID = "E863F12E-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveLastActivation = function() {
	HAP.Characteristic.call(this, "Eve Last Activation", "E863F11A-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT32,
        unit: HAP.Characteristic.Units.SECONDS,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveLastActivation, HAP.Characteristic);
HAP.Characteristic.EveLastActivation.UUID = "E863F11A-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveTimesOpened = function() {
	HAP.Characteristic.call(this, "Eve Times Opened", "E863F129-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT32,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveTimesOpened, HAP.Characteristic);
HAP.Characteristic.EveTimesOpened.UUID = "E863F129-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveClosedDuration = function() {
	HAP.Characteristic.call(this, "Eve Closed Duration", "E863F118-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT32,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveClosedDuration, HAP.Characteristic);
HAP.Characteristic.EveClosedDuration.UUID = "E863F118-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveOpenDuration = function() {
	HAP.Characteristic.call(this, "Eve Opened Duration", "E863F119-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT32,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveOpenDuration, HAP.Characteristic);
HAP.Characteristic.EveOpenDuration.UUID = "E863F119-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveProgramCommand = function() {
	HAP.Characteristic.call(this, "Eve Program Command", "E863F12C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
        perms: [HAP.Characteristic.Perms.WRITE]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveProgramCommand, HAP.Characteristic);
HAP.Characteristic.EveProgramCommand.UUID = "E863F12C-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveProgramData = function() {
	HAP.Characteristic.call(this, "Eve Program Data", "E863F12F-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveProgramData, HAP.Characteristic);
HAP.Characteristic.EveProgramData.UUID = "E863F12F-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveElectricalVoltage = function() {
	HAP.Characteristic.call(this, "Eve Voltage", "E863F10A-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        unit: "V",
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveElectricalVoltage, HAP.Characteristic);
HAP.Characteristic.EveElectricalVoltage.UUID = "E863F10A-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveElectricalCurrent = function() {
	HAP.Characteristic.call(this, "Eve Current", "E863F126-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        unit: "A",
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveElectricalCurrent, HAP.Characteristic);
HAP.Characteristic.EveElectricalCurrent.UUID = "E863F126-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveTotalConsumption = function() {
	HAP.Characteristic.call(this, "Eve Total Consumption", "E863F10C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveTotalConsumption, HAP.Characteristic);
HAP.Characteristic.EveTotalConsumption.UUID = "E863F10C-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveElectricalWattage = function() {
	HAP.Characteristic.call(this, "Eve Watts", "E863F10D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        unit: "W",
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveElectricalWattage, HAP.Characteristic);
HAP.Characteristic.EveElectricalWattage.UUID = "E863F10D-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveGetConfiguration = function() {
	HAP.Characteristic.call(this, "Eve Get Configuration", "E863F131-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveGetConfiguration, HAP.Characteristic);
HAP.Characteristic.EveGetConfiguration.UUID = "E863F131-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveSetConfiguration = function() {
	HAP.Characteristic.call(this, "Eve Set Configuration", "E863F11D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
        perms: [HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveSetConfiguration, HAP.Characteristic);
HAP.Characteristic.EveSetConfiguration.UUID = "E863F11D-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveFirmware = function() {
	HAP.Characteristic.call(this, "Eve Firmware", "E863F11E-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.DATA,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveFirmware, HAP.Characteristic);
HAP.Characteristic.EveFirmware.UUID = "E863F11E-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveSensitivity = function() {
	HAP.Characteristic.call(this, "Eve Motion Sensitivity", "E863F120-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.NOTIFY],
        minValue: 0,
        maxValue: 7,
        validValues: [0, 4, 7]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveSensitivity, HAP.Characteristic);
HAP.Characteristic.EveSensitivity.UUID = "E863F120-079E-48FF-8F27-9C2605A29F52";
HAP.Characteristic.EveSensitivity.HIGH = 0;
HAP.Characteristic.EveSensitivity.MEDIUM = 4;
HAP.Characteristic.EveSensitivity.LOW = 7;

HAP.Characteristic.EveDuration = function() {
	HAP.Characteristic.call(this, "Eve Motion Duration", "E863F12D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT16,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.NOTIFY],
        minValue: 5,
        maxValue: 54000,
        validValues: [5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 36000, 43200, 54000]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveDuration, HAP.Characteristic);
HAP.Characteristic.EveDuration.UUID = "E863F12D-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveDeviceStatus = function() {
	HAP.Characteristic.call(this, "Eve Device Status", "E863F134-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT32,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveDeviceStatus, HAP.Characteristic);
HAP.Characteristic.EveDeviceStatus.UUID = "E863F134-079E-48FF-8F27-9C2605A29F52";
HAP.Characteristic.EveDeviceStatus.SMOKE_DETECTED = (1 << 0);
HAP.Characteristic.EveDeviceStatus.HEAT_DETECTED = (1 << 1);
HAP.Characteristic.EveDeviceStatus.ALARM_TEST_ACTIVE = (1 << 2);
HAP.Characteristic.EveDeviceStatus.SMOKE_SENSOR_ERROR = (1 << 5);
HAP.Characteristic.EveDeviceStatus.HEAT_SENSOR_ERROR = (1 << 7);
HAP.Characteristic.EveDeviceStatus.SMOKE_CHAMBER_ERROR = (1 << 9);
HAP.Characteristic.EveDeviceStatus.SMOKE_SENSOR_DEACTIVATED = (1 << 14);
HAP.Characteristic.EveDeviceStatus.FLASH_STATUS_LED = (1 << 15);
HAP.Characteristic.EveDeviceStatus.ALARM_PAUSED = (1 << 24);
HAP.Characteristic.EveDeviceStatus.ALARM_MUTED = (1 << 25);

HAP.Characteristic.EveAirPressure = function() {
	HAP.Characteristic.call(this, "Eve Air Pressure", "E863F10F-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT16,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "hPa",
        minValue: 700,
        maxValue: 1100,
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveAirPressure, HAP.Characteristic);
HAP.Characteristic.EveAirPressure.UUID = "E863F10F-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveElevation = function() {
	HAP.Characteristic.call(this, "Eve Elevation", "E863F130-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.INT,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.WRITE, HAP.Characteristic.Perms.NOTIFY],
        unit: "m",
        minValue: -430,
        maxValue: 8850,
        minStep: 10,
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveElevation, HAP.Characteristic);
HAP.Characteristic.EveElevation.UUID = "E863F130-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveVOCLevel = function() {
	HAP.Characteristic.call(this, "VOC Level", "E863F10B-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT16,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "ppm",
        minValue: 5,
        maxValue: 5000,
        minStep: 5,
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveVOCLevel, HAP.Characteristic);
HAP.Characteristic.EveVOCLevel.UUID = "E863F10B-079E-48FF-8F27-9C2605A29F52";

HAP.Characteristic.EveWeatherTrend = function() {
	HAP.Characteristic.call(this, "Eve Weather Trend", "E863F136-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        minValue: 0,
        maxValue: 15,
        minStep: 1,
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.EveWeatherTrend, HAP.Characteristic);
HAP.Characteristic.EveWeatherTrend.UUID = "E863F136-079E-48FF-8F27-9C2605A29F52";
HAP.Characteristic.EveWeatherTrend.BLANK = 0; // also: 2, 8, 10
HAP.Characteristic.EveWeatherTrend.SUN = 1; // also: 9
HAP.Characteristic.EveWeatherTrend.CLOUDS_SUN = 3; // also: 11
HAP.Characteristic.EveWeatherTrend.RAIN = 4; // also: 5, 6, 7
HAP.Characteristic.EveWeatherTrend.RAIN_WIND = 12; // also: 13, 14, 15

// EveHomeHistory Service
HAP.Service.EveHomeHistory = function (displayName, subtype) {
	HAP.Service.call(this, displayName, "E863F007-079E-48FF-8F27-9C2605A29F52", subtype);

    // Required Characteristics
    this.addCharacteristic(HAP.Characteristic.EveResetTotal);
    this.addCharacteristic(HAP.Characteristic.EveHistoryStatus);
    this.addCharacteristic(HAP.Characteristic.EveHistoryEntries);
    this.addCharacteristic(HAP.Characteristic.EveHistoryRequest);
    this.addCharacteristic(HAP.Characteristic.EveSetTime);
}
util.inherits(HAP.Service.EveHomeHistory, HAP.Service);
HAP.Service.EveHomeHistory.UUID = "E863F007-079E-48FF-8F27-9C2605A29F52";

// Eve custom air pressure service
HAP.Service.EveAirPressureSensor = function(displayName, subtype) {
	HAP.Service.call(this, displayName, "E863F00A-079E-48FF-8F27-9C2605A29F52", subtype);

    // Required Characteristics
    this.addCharacteristic(HAP.Characteristic.EveAirPressure);
    this.addCharacteristic(HAP.Characteristic.EveElevation);
}
util.inherits(HAP.Service.EveAirPressureSensor, HAP.Service);
HAP.Service.EveAirPressureSensor.UUID = "E863F00A-079E-48FF-8F27-9C2605A29F52";


// Other UUIDs Eve Home recognises
HAP.Characteristic.ApparentTemperature = function() {
	HAP.Characteristic.call(this, "ApparentTemperature", "C1283352-3D12-4777-ACD5-4734760F1AC8");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: HAP.Characteristic.Units.CELSIUS,
        minValue: -40,
        maxValue: 100,
        minStep: 0.1
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.ApparentTemperature, HAP.Characteristic);
HAP.Characteristic.ApparentTemperature.UUID = "C1283352-3D12-4777-ACD5-4734760F1AC8";

HAP.Characteristic.CloudCover = function() {
	HAP.Characteristic.call(this, "Cloud Cover", "64392FED-1401-4F7A-9ADB-1710DD6E3897");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: HAP.Characteristic.Units.PERCENTAGE,
        minValue: 0,
        maxValue: 100
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.CloudCover, HAP.Characteristic);
HAP.Characteristic.CloudCover.UUID = "64392FED-1401-4F7A-9ADB-1710DD6E3897";

HAP.Characteristic.Condition = function() {
	HAP.Characteristic.call(this, "Condition", "CD65A9AB-85AD-494A-B2BD-2F380084134D");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.Condition, HAP.Characteristic);
HAP.Characteristic.Condition.UUID = "CD65A9AB-85AD-494A-B2BD-2F380084134D";

HAP.Characteristic.ConditionCategory = function() {
	HAP.Characteristic.call(this, "Condition Category", "CD65A9AB-85AD-494A-B2BD-2F380084134C");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        minValue: 0,
        maxValue: 9
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.ConditionCategory, HAP.Characteristic);
HAP.Characteristic.ConditionCategory.UUID = "CD65A9AB-85AD-494A-B2BD-2F380084134C";

HAP.Characteristic.DewPoint = function() {
	HAP.Characteristic.call(this, "Dew Point", "095C46E2-278E-4E3C-B9E7-364622A0F501");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: HAP.Characteristic.Units.CELSIUS,
        minValue: -40,
        maxValue: 100,
        minStep: 0.1
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.DewPoint, HAP.Characteristic);
HAP.Characteristic.DewPoint.UUID = "095C46E2-278E-4E3C-B9E7-364622A0F501";

HAP.Characteristic.ForecastDay = function() {
	HAP.Characteristic.call(this, "Day", "57F1D4B2-0E7E-4307-95B5-808750E2C1C7");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.ForecastDay, HAP.Characteristic);
HAP.Characteristic.ForecastDay.UUID = "57F1D4B2-0E7E-4307-95B5-808750E2C1C7";

HAP.Characteristic.MaximumWindSpeed = function() {
	HAP.Characteristic.call(this, "Maximum Wind Speed", "6B8861E5-D6F3-425C-83B6-069945FFD1F1");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "km/h",
        minValue: 0,
        maxValue: 150,
        minStep: 0.1
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.MaximumWindSpeed, HAP.Characteristic);
HAP.Characteristic.MaximumWindSpeed.UUID = "6B8861E5-D6F3-425C-83B6-069945FFD1F1";

HAP.Characteristic.MinimumTemperature = function() {
	HAP.Characteristic.call(this, "Minimum Temperature", "707B78CA-51AB-4DC9-8630-80A58F07E41");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: HAP.Characteristic.Units.CELSIUS,
        minValue: -40,
        maxValue: 100,
        minStep: 0.1
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.MinimumTemperature, HAP.Characteristic);
HAP.Characteristic.MinimumTemperature.UUID = "707B78CA-51AB-4DC9-8630-80A58F07E41";

HAP.Characteristic.ObservationStation = function() {
	HAP.Characteristic.call(this, "Observation Station", "D1B2787D-1FC4-4345-A20E-7B5A74D693ED");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.ObservationStation, HAP.Characteristic);
HAP.Characteristic.ObservationStation.UUID = "D1B2787D-1FC4-4345-A20E-7B5A74D693ED";

HAP.Characteristic.ObservationTime = function() {
	HAP.Characteristic.call(this, "Observation Time", "234FD9F1-1D33-4128-B622-D052F0C402AF");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.ObservationTime, HAP.Characteristic);
HAP.Characteristic.ObservationTime.UUID = "234FD9F1-1D33-4128-B622-D052F0C402AF";

HAP.Characteristic.Ozone = function() {
	HAP.Characteristic.call(this, "Ozone", "BBEFFDDD-1BCD-4D75-B7CD-B57A90A04D13");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "DU",
        minValue: 0,
        maxValue: 500
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.Ozone, HAP.Characteristic);
HAP.Characteristic.Ozone.UUID = "BBEFFDDD-1BCD-4D75-B7CD-B57A90A04D13";

HAP.Characteristic.Rain = function() {
	HAP.Characteristic.call(this, "Rain", "F14EB1AD-E000-4EF4-A54F-0CF07B2E7BE7");
	this.setProps({
        format: HAP.Characteristic.Formats.BOOL,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.Rain, HAP.Characteristic);
HAP.Characteristic.Rain.UUID = "F14EB1AD-E000-4EF4-A54F-0CF07B2E7BE7";

HAP.Characteristic.RainLastHour = function() {
	HAP.Characteristic.call(this, "Rain Last Hour", "10C88F40-7EC4-478C-8D5A-BD0C3CCE14B7");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT16,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "mm",
        minValue: 0,
        maxValue: 200
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.RainLastHour, HAP.Characteristic);
HAP.Characteristic.RainLastHour.UUID = "10C88F40-7EC4-478C-8D5A-BD0C3CCE14B7";

HAP.Characteristic.TotalRain = function() {
	HAP.Characteristic.call(this, "Total Rain", "CCC04890-565B-4376-B39A-3113341D9E0F");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT16,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "mm",
        minValue: 0,
        maxValue: 2000
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.TotalRain, HAP.Characteristic);
HAP.Characteristic.TotalRain.UUID = "CCC04890-565B-4376-B39A-3113341D9E0F";

HAP.Characteristic.RainProbability = function() {
	HAP.Characteristic.call(this, "Rain Probability", "FC01B24F-CF7E-4A74-90DB-1B427AF1FFA3");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: HAP.Characteristic.Units.PERCENTAGE,
        minValue: 0,
        maxValue: 100
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.RainProbability, HAP.Characteristic);
HAP.Characteristic.RainProbability.UUID = "FC01B24F-CF7E-4A74-90DB-1B427AF1FFA3";

HAP.Characteristic.Snow = function() {
	HAP.Characteristic.call(this, "Snow", "F14EB1AD-E000-4CE6-BD0E-384F9EC4D5DD");
	this.setProps({
        format: HAP.Characteristic.Formats.BOOL,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.Snow, HAP.Characteristic);
HAP.Characteristic.Snow.UUID = "F14EB1AD-E000-4CE6-BD0E-384F9EC4D5DD";

HAP.Characteristic.SolarRadiation = function() {
	HAP.Characteristic.call(this, "Solar Radiation", "1819A23E-ECAB-4D39-B29A-7364D299310B");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT16,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "W/m²",
        minValue: 0,
        maxValue: 2000
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.SolarRadiation, HAP.Characteristic);
HAP.Characteristic.SolarRadiation.UUID = "1819A23E-ECAB-4D39-B29A-7364D299310B";

HAP.Characteristic.SunriseTime = function() {
	HAP.Characteristic.call(this, "Sunrise", "0D96F60E-3688-487E-8CEE-D75F05BB3008");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.SunriseTime, HAP.Characteristic);
HAP.Characteristic.SunriseTime.UUID = "0D96F60E-3688-487E-8CEE-D75F05BB3008";

HAP.Characteristic.SunsetTime = function() {
	HAP.Characteristic.call(this, "Sunset", "3DE24EE0-A288-4E15-A5A8-EAD2451B727C");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.SunsetTime, HAP.Characteristic);
HAP.Characteristic.SunsetTime.UUID = "3DE24EE0-A288-4E15-A5A8-EAD2451B727C";

HAP.Characteristic.UVIndex = function() {
	HAP.Characteristic.call(this, "UV Index", "05BA0FE0-B848-4226-906D-5B64272E05CE");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        minValue: 0,
        maxValue: 16
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.UVIndex, HAP.Characteristic);
HAP.Characteristic.UVIndex.UUID = "05BA0FE0-B848-4226-906D-5B64272E05CE";

HAP.Characteristic.Visibility = function() {
	HAP.Characteristic.call(this, "Visibility", "D24ECC1E-6FAD-4FB5-8137-5AF88BD5E857");
	this.setProps({
        format: HAP.Characteristic.Formats.UINT8,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "km",
        minValue: 0,
        maxValue: 100
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.Visibility, HAP.Characteristic);
HAP.Characteristic.Visibility.UUID = "D24ECC1E-6FAD-4FB5-8137-5AF88BD5E857";

HAP.Characteristic.WindDirection = function() {
	HAP.Characteristic.call(this, "Wind Direction", "46F1284C-1912-421B-82F5-EB75008B167E");
	this.setProps({
        format: HAP.Characteristic.Formats.STRING,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.WindDirection, HAP.Characteristic);
HAP.Characteristic.WindDirection.UUID = "46F1284C-1912-421B-82F5-EB75008B167E";

HAP.Characteristic.WindSpeed = function() {
	HAP.Characteristic.call(this, "Wind Speed", "49C8AE5A-A3A5-41AB-BF1F-12D5654F9F41");
	this.setProps({
        format: HAP.Characteristic.Formats.FLOAT,
        perms: [HAP.Characteristic.Perms.READ, HAP.Characteristic.Perms.NOTIFY],
        unit: "km/h",
        minValue: 0,
        maxValue: 150,
        minStep: 0.1
	});
	this.value = this.getDefaultValue();
}
util.inherits(HAP.Characteristic.WindSpeed, HAP.Characteristic);
HAP.Characteristic.WindSpeed.UUID = "49C8AE5A-A3A5-41AB-BF1F-12D5654F9F41";

module.exports = HomeKitHistory;