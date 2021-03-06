/**
 * Main controller for Ghost frontend
 */

/*global require, module */

var moment      = require('moment'),
    RSS         = require('rss'),
    _           = require('lodash'),
    url         = require('url'),
    when        = require('when'),
    Route       = require('express').Route,

    api         = require('../api'),
    config      = require('../config'),
    errors      = require('../errorHandling'),
    filters     = require('../../server/filters'),

    frontendControllers,
    // Cache static post permalink regex
    staticPostPermalink = new Route(null, '/:slug/:edit?');


frontendControllers = {
    'homepage': function (req, res, next) {
        // Parse the page number
        var pageParam = req.params.page !== undefined ? parseInt(req.params.page, 10) : 1,
            postsPerPage,
            options = {};

        // No negative pages, or page 1
        if (isNaN(pageParam) || pageParam < 1 || (pageParam === 1 && req.route.path === '/page/:page/')) {
            return res.redirect(config().paths.subdir + '/');
        }

        return api.settings.read('postsPerPage').then(function (postPP) {
            postsPerPage = parseInt(postPP.value, 10);
            options.page = pageParam;

            // No negative posts per page, must be number
            if (!isNaN(postsPerPage) && postsPerPage > 0) {
                options.limit = postsPerPage;
            }
            return;
        }).then(function () {
            return api.posts.browse(options);
        }).then(function (page) {
            var maxPage = page.pages;

            // A bit of a hack for situations with no content.
            if (maxPage === 0) {
                maxPage = 1;
                page.pages = 1;
            }

            // If page is greater than number of pages we have, redirect to last page
            if (pageParam > maxPage) {
                return res.redirect(maxPage === 1 ? config().paths.subdir + '/' : (config().paths.subdir + '/page/' + maxPage + '/'));
            }

            // Render the page of posts
            filters.doFilter('prePostsRender', page.posts).then(function (posts) {
                res.render('index', {posts: posts, pagination: {page: page.page, prev: page.prev, next: page.next, limit: page.limit, total: page.total, pages: page.pages}});
            });
        }).otherwise(function (err) {
            var e = new Error(err.message);
            e.status = err.errorCode;
            return next(e);
        });
    },
    'single': function (req, res, next) {
        var path = req.path,
            params,
            editFormat,
            usingStaticPermalink = false;

        api.settings.read('permalinks').then(function (permalink) {
            editFormat = permalink.value[permalink.value.length - 1] === '/' ? ':edit?' : '/:edit?';

            // Convert saved permalink into an express Route object
            permalink = new Route(null, permalink.value + editFormat);

            // Check if the path matches the permalink structure.
            //
            // If there are no matches found we then
            // need to verify it's not a static post,
            // and test against that permalink structure.
            if (permalink.match(path) === false) {
                // If there are still no matches then return.
                if (staticPostPermalink.match(path) === false) {
                    // Throw specific error
                    // to break out of the promise chain.
                    throw new Error('no match');
                }

                permalink = staticPostPermalink;
                usingStaticPermalink = true;
            }

            params = permalink.params;

            // Sanitize params we're going to use to lookup the post.
            var postLookup = _.pick(permalink.params, 'slug', 'id');

            // Query database to find post
            return api.posts.read(postLookup);
        }).then(function (post) {

            if (!post) {
                return next();
            }

            function render() {
                // If we're ready to render the page but the last param is 'edit' then we'll send you to the edit page.
                if (params.edit !== undefined) {
                    return res.redirect(config().paths.subdir + '/ghost/editor/' + post.id + '/');
                }
                filters.doFilter('prePostsRender', post).then(function (post) {
                    api.settings.read('activeTheme').then(function (activeTheme) {
                        var paths = config().paths.availableThemes[activeTheme.value],
                            view = post.page && paths.hasOwnProperty('page') ? 'page' : 'post';
                        res.render(view, {post: post});
                    });
                });
            }

            // If we've checked the path with the static permalink structure
            // then the post must be a static post.
            // If it is not then we must return.
            if (usingStaticPermalink) {
                if (post.page === 1) {
                    return render();
                }

                return next();
            }

            // If there is any date based paramter in the slug
            // we will check it against the post published date
            // to verify it's correct.
            if (params.year || params.month || params.day) {
                var slugDate = [],
                    slugFormat = [];

                if (params.year) {
                    slugDate.push(params.year);
                    slugFormat.push('YYYY');
                }

                if (params.month) {
                    slugDate.push(params.month);
                    slugFormat.push('MM');
                }

                if (params.day) {
                    slugDate.push(params.day);
                    slugFormat.push('DD');
                }

                slugDate = slugDate.join('/');
                slugFormat = slugFormat.join('/');

                if (slugDate === moment(post.published_at).format(slugFormat)) {
                    return render();
                }

                return next();
            }

            render();

        }).otherwise(function (err) {
            // If we've thrown an error message
            // of 'no match' then we found
            // no path match.
            if (err.message === 'no match') {
                return next();
            }

            var e = new Error(err.message);
            e.status = err.errorCode;
            return next(e);
        });
    },
    'edit': function (req, res, next) {
        req.params[2] = 'edit';
        return frontendControllers.single(req, res, next);
    },
    'rss': function (req, res, next) {
        // Initialize RSS
        var pageParam = req.params.page !== undefined ? parseInt(req.params.page, 10) : 1,
            feed;

        // No negative pages, or page 1
        if (isNaN(pageParam) || pageParam < 1 || (pageParam === 1 && req.route.path === '/rss/:page/')) {
            return res.redirect(config().paths.subdir + '/rss/');
        }

        // TODO: needs refactor for multi user to not use first user as default
        return when.settle([
            api.users.read({id : 1}),
            api.settings.read('title'),
            api.settings.read('description'),
            api.settings.read('permalinks')
        ]).then(function (result) {
            var user = result[0].value,
                title = result[1].value.value,
                description = result[2].value.value,
                permalinks = result[3].value,
                siteUrl = config.urlFor('home', null, true),
                feedUrl =  config.urlFor('rss', null, true);

            feed = new RSS({
                title: title,
                description: description,
                generator: 'Ghost v' + res.locals.version,
                feed_url: feedUrl,
                site_url: siteUrl,
                ttl: '60'
            });

            return api.posts.browse({page: pageParam}).then(function (page) {
                var maxPage = page.pages,
                    feedItems = [];

                // A bit of a hack for situations with no content.
                if (maxPage === 0) {
                    maxPage = 1;
                    page.pages = 1;
                }

                // If page is greater than number of pages we have, redirect to last page
                if (pageParam > maxPage) {
                    return res.redirect(config().paths.subdir + '/rss/' + maxPage + '/');
                }

                filters.doFilter('prePostsRender', page.posts).then(function (posts) {
                    posts.forEach(function (post) {
                        var deferred = when.defer(),
                            item = {
                                title:  _.escape(post.title),
                                guid: post.uuid,
                                url: config.urlFor('post', {post: post, permalinks: permalinks}, true),
                                date: post.published_at,
                                categories: _.pluck(post.tags, 'name'),
                                author: user ? user.name : null
                            },
                            content = post.html;

                        //set img src to absolute url
                        content = content.replace(/src=["|'|\s]?([\w\/\?\$\.\+\-;%:@&=,_]+)["|'|\s]?/gi, function (match, p1) {
                            /*jslint unparam:true*/
                            p1 = url.resolve(siteUrl, p1);
                            return "src='" + p1 + "' ";
                        });
                        //set a href to absolute url
                        content = content.replace(/href=["|'|\s]?([\w\/\?\$\.\+\-;%:@&=,_]+)["|'|\s]?/gi, function (match, p1) {
                            /*jslint unparam:true*/
                            p1 = url.resolve(siteUrl, p1);
                            return "href='" + p1 + "' ";
                        });
                        item.description = content;
                        feed.item(item);
                        deferred.resolve();
                        feedItems.push(deferred.promise);
                    });
                });

                when.all(feedItems).then(function () {
                    res.set('Content-Type', 'text/xml');
                    res.send(feed.xml());
                });
            });
        }).otherwise(function (err) {
            var e = new Error(err.message);
            e.status = err.errorCode;
            return next(e);
        });
    }
};

module.exports = frontendControllers;
