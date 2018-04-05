/*!
 * acme-v2.js
 * Copyright(c) 2018 AJ ONeal <aj@ppl.family> https://ppl.family
 * Apache-2.0 OR MIT (and hence also MPL 2.0)
 */
'use strict';
/* globals Promise */

var ACME = module.exports.ACME = {};

ACME.acmeChallengePrefix = '/.well-known/acme-challenge/';

ACME._getUserAgentString = function (deps) {
  var uaDefaults = {
      pkg: "Greenlock/" + deps.pkg.version
    , os: "(" + deps.os.type() + "; " + deps.process.arch + " " + deps.os.platform() + " " + deps.os.release() + ")"
    , node: "Node.js/" + deps.process.version
    , user: ''
  };

  var userAgent = [];

  //Object.keys(currentUAProps)
  Object.keys(uaDefaults).forEach(function (key) {
    if (uaDefaults[key]) {
      userAgent.push(uaDefaults[key]);
    }
  });

  return userAgent.join(' ').trim();
};
ACME._directory = function (me) {
  return me._request({ url: me.directoryUrl, json: true });
};
ACME._getNonce = function (me) {
  if (me._nonce) { return new Promise(function (resolve) { resolve(me._nonce); return; }); }
  return me._request({ method: 'HEAD', url: me._directoryUrls.newNonce }).then(function (resp) {
    me._nonce = resp.toJSON().headers['replay-nonce'];
    return me._nonce;
  });
};
// ACME RFC Section 7.3 Account Creation
/*
 {
   "protected": base64url({
     "alg": "ES256",
     "jwk": {...},
     "nonce": "6S8IqOGY7eL2lsGoTZYifg",
     "url": "https://example.com/acme/new-account"
   }),
   "payload": base64url({
     "termsOfServiceAgreed": true,
     "onlyReturnExisting": false,
     "contact": [
       "mailto:cert-admin@example.com",
       "mailto:admin@example.com"
     ]
   }),
   "signature": "RZPOnYoPs1PhjszF...-nh6X1qtOFPB519I"
 }
*/
ACME._registerAccount = function (me, options) {
  console.log('[acme-v2] accounts.create');

  return ACME._getNonce(me).then(function () {
    return new Promise(function (resolve, reject) {

      function agree(tosUrl) {
        var err;
        if (me._tos !== tosUrl) {
          err = new Error("You must agree to the ToS at '" + me._tos + "'");
          err.code = "E_AGREE_TOS";
          reject(err);
          return;
        }

        var jwk = me.RSA.exportPublicJwk(options.accountKeypair);
        var body = {
          termsOfServiceAgreed: tosUrl === me._tos
        , onlyReturnExisting: false
        , contact: [ 'mailto:' + options.email ]
        };
        if (options.externalAccount) {
          body.externalAccountBinding = me.RSA.signJws(
            options.externalAccount.secret
          , undefined
          , { alg: "HS256"
            , kid: options.externalAccount.id
            , url: me._directoryUrls.newAccount
            }
          , new Buffer(JSON.stringify(jwk))
          );
        }
        var payload = JSON.stringify(body);
        var jws = me.RSA.signJws(
          options.accountKeypair
        , undefined
        , { nonce: me._nonce
          , alg: 'RS256'
          , url: me._directoryUrls.newAccount
          , jwk: jwk
          }
        , new Buffer(payload)
        );

        console.log('[acme-v2] accounts.create JSON body:');
        delete jws.header;
        console.log(jws);
        me._nonce = null;
        return me._request({
          method: 'POST'
        , url: me._directoryUrls.newAccount
        , headers: { 'Content-Type': 'application/jose+json' }
        , json: jws
        }).then(function (resp) {
          me._nonce = resp.toJSON().headers['replay-nonce'];
          var location = resp.toJSON().headers.location;
          console.log('[DEBUG] new account location:'); // the account id url
          console.log(location); // the account id url
          console.log(resp.toJSON());
          me._kid = location;
          return resp.body;
        }).then(resolve, reject);
      }

      console.log('[acme-v2] agreeToTerms');
      if (1 === options.agreeToTerms.length) {
        return options.agreeToTerms(me._tos).then(agree, reject);
      }
      else if (2 === options.agreeToTerms.length) {
        return options.agreeToTerms(me._tos, function (err, tosUrl) {
          if (!err) { agree(tosUrl); return; }
          reject(err);
        });
      }
      else {
        reject(new Error('agreeToTerms has incorrect function signature.'
          + ' Should be fn(tos) { return Promise<tos>; }'));
      }
    });
  });
};
/*
 POST /acme/new-order HTTP/1.1
 Host: example.com
 Content-Type: application/jose+json

 {
   "protected": base64url({
     "alg": "ES256",
     "kid": "https://example.com/acme/acct/1",
     "nonce": "5XJ1L3lEkMG7tR6pA00clA",
     "url": "https://example.com/acme/new-order"
   }),
   "payload": base64url({
     "identifiers": [{"type:"dns","value":"example.com"}],
     "notBefore": "2016-01-01T00:00:00Z",
     "notAfter": "2016-01-08T00:00:00Z"
   }),
   "signature": "H6ZXtGjTZyUnPeKn...wEA4TklBdh3e454g"
 }
*/
ACME._getChallenges = function (me, options, auth) {
  console.log('\n[DEBUG] getChallenges\n');
  return me._request({ method: 'GET', url: auth, json: true }).then(function (resp) {
    return resp.body;
  });
};
ACME._wait = function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, (ms || 1100));
  });
};
// https://tools.ietf.org/html/draft-ietf-acme-acme-10#section-7.5.1
ACME._postChallenge = function (me, options, identifier, ch) {
  var body = { };

  var payload = JSON.stringify(body);

  var thumbprint = me.RSA.thumbprint(options.accountKeypair);
  var keyAuthorization = ch.token + '.' + thumbprint;
  //   keyAuthorization = token || '.' || base64url(JWK_Thumbprint(accountKey))
  //   /.well-known/acme-challenge/:token

  return new Promise(function (resolve, reject) {
    function failChallenge(err) {
      if (err) { reject(err); return; }
      testChallenge();
    }

    function testChallenge() {
      // TODO put check dns / http checks here?
      // http-01: GET https://example.org/.well-known/acme-challenge/{{token}} => {{keyAuth}}
      // dns-01: TXT _acme-challenge.example.org. => "{{urlSafeBase64(sha256(keyAuth))}}"

      function pollStatus() {
        console.log('\n[DEBUG] statusChallenge\n');
        return me._request({ method: 'GET', url: ch.url, json: true }).then(function (resp) {
          console.error('poll: resp.body:');
          console.error(resp.body);

          if ('pending' === resp.body.status) {
            console.log('poll: again');
            return ACME._wait(1 * 1000).then(pollStatus);
          }

          if ('valid' === resp.body.status) {
            console.log('poll: valid');
            try {
              if (1 === options.removeChallenge.length) {
                options.removeChallenge(
                  { identifier: identifier
                  , type: ch.type
                  , token: ch.token
                  }
                ).then(function () {}, function () {});
              } else if (2 === options.removeChallenge.length) {
                options.removeChallenge(
                  { identifier: identifier
                  , type: ch.type
                  , token: ch.token
                  }
                , function (err) { return err; }
                );
              } else {
                options.removeChallenge(identifier.value, ch.token, function () {});
              }
            } catch(e) {}
            return resp.body;
          }

          if (!resp.body.status) {
            console.error("[acme-v2] (y) bad challenge state:");
          }
          else if ('invalid' === resp.body.status) {
            console.error("[acme-v2] (x) invalid challenge state:");
          }
          else {
            console.error("[acme-v2] (z) bad challenge state:");
          }

          return Promise.reject(new Error("[acme-v2] bad challenge state"));
        });
      }

      console.log('\n[DEBUG] postChallenge\n');
      //console.log('\n[DEBUG] stop to fix things\n'); return;

      function post() {
        var jws = me.RSA.signJws(
          options.accountKeypair
        , undefined
        , { nonce: me._nonce, alg: 'RS256', url: ch.url, kid: me._kid }
        , new Buffer(payload)
        );
        me._nonce = null;
        return me._request({
          method: 'POST'
        , url: ch.url
        , headers: { 'Content-Type': 'application/jose+json' }
        , json: jws
        }).then(function (resp) {
          me._nonce = resp.toJSON().headers['replay-nonce'];
          console.log('respond to challenge: resp.body:');
          console.log(resp.body);
          return ACME._wait(1 * 1000).then(pollStatus).then(resolve, reject);
        });
      }

      return ACME._wait(1 * 1000).then(post);
    }

    try {
      if (1 === options.setChallenge.length) {
        options.setChallenge(
          { identifier: identifier
          , hostname: identifier.value
          , type: ch.type
          , token: ch.token
          , thumbprint: thumbprint
          , keyAuthorization: keyAuthorization
          , dnsAuthorization: me.RSA.utils.toWebsafeBase64(
              require('crypto').createHash('sha256').update(keyAuthorization).digest('base64')
            )
          }
        ).then(testChallenge, reject);
      } else if (2 === options.setChallenge.length) {
        options.setChallenge(
          { identifier: identifier
          , hostname: identifier.value
          , type: ch.type
          , token: ch.token
          , thumbprint: thumbprint
          , keyAuthorization: keyAuthorization
          , dnsAuthorization: me.RSA.utils.toWebsafeBase64(
              require('crypto').createHash('sha256').update(keyAuthorization).digest('base64')
            )
          }
        , failChallenge
        );
      } else {
        options.setChallenge(identifier.value, ch.token, keyAuthorization, failChallenge);
      }
    } catch(e) {
      reject(e);
    }
  });
};
ACME._finalizeOrder = function (me, options, validatedDomains) {
  console.log('finalizeOrder:');
  var csr = me.RSA.generateCsrWeb64(options.domainKeypair, validatedDomains);
  var body = { csr: csr };
  var payload = JSON.stringify(body);

  function pollCert() {
    var jws = me.RSA.signJws(
      options.accountKeypair
    , undefined
    , { nonce: me._nonce, alg: 'RS256', url: me._finalize, kid: me._kid }
    , new Buffer(payload)
    );

    console.log('finalize:', me._finalize);
    me._nonce = null;
    return me._request({
      method: 'POST'
    , url: me._finalize
    , headers: { 'Content-Type': 'application/jose+json' }
    , json: jws
    }).then(function (resp) {
      me._nonce = resp.toJSON().headers['replay-nonce'];

      console.log('order finalized: resp.body:');
      console.log(resp.body);

      if ('processing' === resp.body.status) {
        return ACME._wait().then(pollCert);
      }

      if ('valid' === resp.body.status) {
        me._expires = resp.body.expires;
        me._certificate = resp.body.certificate;

        return resp.body;
      }

      if ('invalid' === resp.body.status) {
        console.error('cannot finalize: badness');
        return;
      }

      console.error('(x) cannot finalize: badness');
      return;
    });
  }

  return pollCert();
};
ACME._getCertificate = function (me, options) {
  console.log('[acme-v2] DEBUG get cert 1');

  if (!options.challengeTypes) {
    if (!options.challengeType) {
      return Promise.reject(new Error("challenge type must be specified"));
    }
    options.challengeTypes = [ options.challengeType ];
  }

  console.log('[acme-v2] certificates.create');
  return ACME._getNonce(me).then(function () {
    var body = {
      identifiers: options.domains.map(function (hostname) {
        return { type: "dns" , value: hostname };
      })
      //, "notBefore": "2016-01-01T00:00:00Z"
      //, "notAfter": "2016-01-08T00:00:00Z"
    };

    var payload = JSON.stringify(body);
    var jws = me.RSA.signJws(
      options.accountKeypair
    , undefined
    , { nonce: me._nonce, alg: 'RS256', url: me._directoryUrls.newOrder, kid: me._kid }
    , new Buffer(payload)
    );

    console.log('\n[DEBUG] newOrder\n');
    me._nonce = null;
    return me._request({
      method: 'POST'
    , url: me._directoryUrls.newOrder
    , headers: { 'Content-Type': 'application/jose+json' }
    , json: jws
    }).then(function (resp) {
      me._nonce = resp.toJSON().headers['replay-nonce'];
      var location = resp.toJSON().headers.location;
      console.log(location); // the account id url
      console.log(resp.toJSON());
      me._authorizations = resp.body.authorizations;
      me._order = location;
      me._finalize = resp.body.finalize;
      //console.log('[DEBUG] finalize:', me._finalize); return;

      //return resp.body;
      return Promise.all(me._authorizations.map(function (authUrl, i) {
        console.log("Authorizations map #" + i);
        return ACME._getChallenges(me, options, authUrl).then(function (results) {
          // var domain = options.domains[i]; // results.identifier.value
          var chType = options.challengeTypes.filter(function (chType) {
            return results.challenges.some(function (ch) {
              return ch.type === chType;
            });
          })[0];

          var challenge = results.challenges.filter(function (ch) {
            if (chType === ch.type) {
              return ch;
            }
          })[0];

          if (!challenge) {
            return Promise.reject(new Error("Server didn't offer any challenge we can handle."));
          }

          return ACME._postChallenge(me, options, results.identifier, challenge);
        });
      })).then(function () {
        var validatedDomains = body.identifiers.map(function (ident) {
          return ident.value;
        });

        return ACME._finalizeOrder(me, options, validatedDomains);
      }).then(function () {
        return me._request({ method: 'GET', url: me._certificate, json: true }).then(function (resp) {
          console.log('Certificate:');
          console.log(resp.body);
          return resp.body;
        });
      });
    });
  });
};

ACME.create = function create(me) {
  if (!me) { me = {}; }
  me.acmeChallengePrefix = ACME.acmeChallengePrefix;
  me.RSA = me.RSA || require('rsa-compat').RSA;
  me.request = me.request || require('request');
  me.promisify = me.promisify || require('util').promisify;


  if ('function' !== typeof me.getUserAgentString) {
    me.pkg = me.pkg || require('./package.json');
    me.os = me.os || require('os');
    me.process = me.process || require('process');
    me.userAgent = ACME._getUserAgentString(me);
  }

  function getRequest(opts) {
    if (!opts) { opts = {}; }

    return me.request.defaults({
      headers: {
        'User-Agent': opts.userAgent || me.userAgent || me.getUserAgentString(me)
      }
    });
  }

  if ('function' !== typeof me._request) {
    me._request = me.promisify(getRequest({}));
  }

  me.init = function (_directoryUrl) {
    me.directoryUrl = me.directoryUrl || _directoryUrl;
    return ACME._directory(me).then(function (resp) {
      me._directoryUrls = resp.body;
      me._tos = me._directoryUrls.meta.termsOfService;
      return me._directoryUrls;
    });
  };
  me.accounts = {
    create: function (options) {
      return ACME._registerAccount(me, options);
    }
  };
  me.certificates = {
    create: function (options) {
      return ACME._getCertificate(me, options);
    }
  };
  return me;
};
