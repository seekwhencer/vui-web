class Logger {
    constructor({ verbose } = {}) {
        this.verbose = verbose ?? process.env.VERBOSE === 'true';
    }

    /** Stringifiziert ein Argument: Objekte/Arrays als JSON, sonst String. */
    fmt(arg) {
        if (arg === null || arg === undefined) return String(arg);
        if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch { return String(arg); }
        }
        return String(arg);
    }

    log(label, ...args) {
        if (this.verbose) {
            console.log(`${label} ${args.map((a) => this.fmt(a)).join(' ')}`);
        }
    }

    error(label, ...args) {
        console.error(`${label} ${args.map((a) => this.fmt(a)).join(' ')}`);
    }

    setVerbose(verbose) {
        this.verbose = verbose;
    }
}

export { Logger };
