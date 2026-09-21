/**
 * jest 26's resolver predates package.json "exports"; when it cannot find a
 * module, Node's own resolver (which understands "exports" and picks the
 * "require" condition) gets a turn.
 */
module.exports = (request, options) => {
    try {
        return options.defaultResolver(request, options);
    } catch (err) {
        try {
            return require.resolve(request, { paths: [options.basedir] });
        } catch (e2) {
            throw err;
        }
    }
};
