
/**

/browse/:source

/configs

/config/:source

/plugin/:plugin
/plugin/:plugin/js
/plugin/:plugin/css

/pack/:pack
/pack/:pack/js
/pack/:pack/css

**/


const path = require('path');
const stream = require('stream');
const fs = require('fs');
const url = require('url');
const request = require('request');
const jsonld = require('jsonld');
const factory = require('@graphy/core.data.factory');

// third-party modules
const async = require('async');
const browserify = require('browserify');
const h_argv = require('minimist')(process.argv.slice(2));
const mkdirp = require('mkdirp');

const express = require('express');
require('express-negotiate');
const cors = require('cors');
const body_parser = require('body-parser');
const less_middleware = require('less-middleware');
const browserify_middleware = require('browserify-middleware');
const proxy = require('http-proxy-middleware');

const N_PORT = h_argv.p || h_argv.port || 80;
const P_ENDPOINT = h_argv.e || h_argv.endpoint || 'https://stko-kwg.geog.ucsb.edu/graphdb/repositories/KWG';
const P_LITE_ENDPOINT = h_argv.e || h_argv.endpoint || 'https://stko-kwg.geog.ucsb.edu/graphdb/repositories/KWG-Lite'

const P_DIR_PLUGINS = path.resolve(__dirname, '../..', 'plugins');
const P_DIR_FETCH = path.resolve(__dirname, '../..', 'fetch');

const X_MAX_PAYLOAD_SIZE = 16384;

// check status of an npm package
function check_npm_package(s_package, fk_check) {
	// read package.json contents
	fs.readFile(path.join(P_DIR_PLUGINS, 'package.json'), (e_read, s_package_json) => {
		// i/o error
		if(e_read) {
			return fk_check(e_read);
		}

		// parse package.json
		let h_package;
		try {
			h_package = JSON.parse(s_package_json);
		}
		catch(e_package) {
			return fk_check('corrupt package.json file');
		}

		// get package
		fk_check(null, h_package.dependencies[s_package]);
	});
}


// install an npm package
function install_npm_package(s_package, fk_install) {
	// check package first
	check_npm_package(s_package, (e_check, s_semver) => {
		// check error
		if(e_check) {
			return fk_install(e_check);
		}

		// package already installed
		if(s_semver) {
			fk_install(null, s_semver);
		}
		// package not installed
		else {
			fk_install(new Error(`refusing to install package ${s_package}`));
		}
	});
}

function fetch_package(s_plugin, d_res, fk_package) {
	install_npm_package(s_plugin, (e_install, s_data) => {
		// install error
		if(e_install) {
			return d_res.status(400).end('failed to install plugin '+e_install);
		}
		// package is ready
		else {
			// set its directory
			let p_dir_plugin = path.join(P_DIR_PLUGINS, 'node_modules', s_plugin);

			// fetch package.json's main field
			let h_package;
			try {
				h_package = require(path.join(p_dir_plugin, 'package.json'));
			}
			catch(e_package) {
				return d_res.status(500).end(`failed to locate package.json in plugin under ${p_dir_plugin}/package.json`);
			}

			// callback
			fk_package(h_package);
		}
	});
}

function resolve_endpoint(s_endpoint, d_res) {
	if(s_endpoint.startsWith('http://')) {
		d_res.redirect(301, s_endpoint.substr('http://'.length));
		return null;
	}

	if(/^\w+:\/\//.test(s_endpoint)) {
		let d_url;
		try {
			d_url = new url.URL(s_endpoint);
		}
		catch(e_url) {
			d_res.status(400).end('invalid endpoint URL');
			return null;
		}

		if('https:' === d_url.protocol) {
			d_res.status(501).end('support for https endpoints are not yet implemented');
		}
		else {
			d_res.status(400).end('only HTTP protocol is allowed for endpoint URLs');
		}

		return null;
	}

	return s_endpoint;
}

const k_app = express();
const PD_ROOT = path.resolve(__dirname, '../../');
const SCHEMA_BASE_DIR = path.join('static', 'schema');
const SCHEMA_LITE_BASE_DIR = path.join('static', 'kwg-lite');
const R_SAFE_PATH = /^[\w-]+$/;

function assert_safe_path(s_file, d_res) {
	if(!R_SAFE_PATH.test(s_file)) {
		d_res.status(400).end(`bad param name: '${s_file}'`);
	}
}

// middleware body parse
k_app.use(body_parser.json({
	limit: X_MAX_PAYLOAD_SIZE,
}));

// middleware CORS
k_app.use(cors());

// views
k_app.set('views', path.resolve(__dirname, '../webapp/_layouts'));
k_app.set('view engine', 'pug');

// scripts
browserify_middleware.settings.development('minify', true);
browserify_middleware.settings.development('gzip', true);
k_app.use('/static/script', browserify_middleware(__dirname+'/../webapp/_scripts'));

// static routing
k_app.use('/static/style', express.static(__dirname+'/../../build/webapp/_styles'));
k_app.use('/static/resource', express.static(__dirname+'/../../plugins/node_modules/leaflet/dist'));
k_app.use('/static/css', express.static(path.join(PD_ROOT, 'static/css')));
k_app.use('/static/js', express.static(path.join(PD_ROOT, 'static/js')));
k_app.use('/static/images', express.static(path.join(PD_ROOT, 'static/images')));
k_app.use('/static/schema', express.static(path.join(PD_ROOT, SCHEMA_BASE_DIR)));
k_app.use('/static/schema-lite', express.static(path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR)));


k_app.get('/', (d_req, d_res) => {
	d_res.sendFile(path.join(PD_ROOT, 'static/html/index.html'));
});

// browse some source
k_app.get([
	'/browse',
	/^\/browse\/(.+)$/,
], (d_req, d_res) => {
	d_res.render('explore');
});

const D_URL_ENDPOINT = new url.URL(P_ENDPOINT);

// sparql
k_app.use('/sparql', proxy({
	target: D_URL_ENDPOINT.origin,
	// Disable checking that the request is sent over HTTPS (NGINX will take care of this)
	secure: false,
	pathRewrite: {
		'^/sparql': D_URL_ENDPOINT.pathname,
	},
}));



const H_PREFIXES = {
	rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
	rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
	xsd: 'http://www.w3.org/2001/XMLSchema#',
	owl: 'http://www.w3.org/2002/07/owl#',
	dc: 'http://purl.org/dc/elements/1.1/',
	dcterms: 'http://purl.org/dc/terms/',
	foaf: 'http://xmlns.com/foaf/0.1/',
	kwgr: 'http://stko-kwg.geog.ucsb.edu/lod/resource/',
	'kwg-ont':'http://stko-kwg.geog.ucsb.edu/lod/ontology/',
	'kwgl-ont':'http://stko-kwg.geog.ucsb.edu/lod/lite-ontology/',
	'kwglr': 'http://stko-kwg.geog.ucsb.edu/lod/lite-resource/',
	geo: 'http://www.opengis.net/ont/geosparql#',
	ago: 'http://awesemantic-geo.link/ontology/',
};

let s_prefixes = '';
for(let [s_prefix_id, p_prefix_iri] of Object.entries(H_PREFIXES)) {
	s_prefixes += `prefix ${s_prefix_id}: <${p_prefix_iri}>\n`;
}

// submit sparql query via HTTP
const sparql_query = (s_accept, s_query, fk_query, endpoint=P_ENDPOINT) => {
	request.post(endpoint, {
		headers: {
			accept: s_accept,
			'content-type': 'application/sparql-query;charset=UTF-8',
		},
		body: s_prefixes+'\n'+s_query,
	}, fk_query);
};


const negotiate_feature = (d_req, d_res, f_next) => {
	let {
		group: s_group,
		thing: s_thing,
	} = d_req.params;

	// redirection
	//let p_redirect = `http://ld.iospress.nl/browse/#<http://ld.iospress.nl/rdf/${s_group}/${s_thing}>`;
	//let p_redirect = `http://localhost:3001/browse/#<http://stko-directrelief.geog.ucsb.edu/lod/${s_group}/${s_thing}>`;
	//let p_redirect = `http://stko-roy.geog.ucsb.edu:3040/browse/#<http://stko-directrelief.geog.ucsb.edu/lod/${s_group}/${s_thing}>`;
	//let p_redirect = `http://stko-roy.geog.ucsb.edu/browse/#<http://stko-directrelief.geog.ucsb.edu/lod/${s_group}/${s_thing}>`;
	
	let p_redirect = `/browse/#<http://stko-kwg.geog.ucsb.edu/lod/${s_group}/${s_thing}>`;
	//let p_redirect = `http://stko-roy.geog.ucsb.edu/browse/#<http://stko-roy.geog.ucsb.edu/lod/${s_group}/${s_thing}>`;
	//let p_redirect = `http://localhost:3001/browse/#<http://stko-roy.geog.ucsb.edu/lod/${s_group}/${s_thing}>`;

	// entity uri
	//let sv1_entity = factory.namedNode(`http://ld.iospress.nl${d_req.baseUrl}`).verbose();
	//let sv1_entity = factory.namedNode(`http://stko-directrelief.geog.ucsb.edu${d_req.baseUrl}`).verbose();
	//let sv1_entity = factory.namedNode(`http://localhost:3001${d_req.baseUrl}`).verbose();
	//let sv1_entity = factory.namedNode(`http://stko-roy.geog.ucsb.edu:3040${d_req.baseUrl}`).verbose();
	
	let sv1_entity = factory.namedNode(`http://stko-kwg.geog.ucsb.edu${d_req.baseUrl}`).verbose();
	//let sv1_entity = factory.namedNode(`http://stko-roy.geog.ucsb.edu${d_req.baseUrl}`).verbose();
	//let sv1_entity = factory.namedNode(`http://localhost:3001${d_req.baseUrl}`).verbose();
	
	console.log(sv1_entity)
	// HTTP head request
	let b_head_only = 'HEAD' === d_req.method;

	// non-GET
	if(!b_head_only && 'GET' !== d_req.method) {
		return f_next();
	}

	// default is to redirect to page
	let f_redirect = () => {
		d_res.redirect(p_redirect);
	};
	// If the subject is coming from the lite repository-switch endpoints
	let endpoint = P_ENDPOINT
	if (s_group.includes("kwgl")) {
		endpoint = P_LITE_ENDPOINT;
	}
	// application/rdf+xml
	let f_rdf_xml = () => {
		sparql_query('application/rdf+xml', `describe ${sv1_entity}`, (e_query, d_sparql_res, s_res_body) => {
			// response mime type
			d_res.type('application/rdf+xml');

			// response status code
			d_res.statusCode = e_query? 500: d_sparql_res.statusCode;

			// head only; don't send body
			if(b_head_only) return d_res.end();

			// otherwise; send body
			d_res.send(s_res_body);
		}, endpoint);
	};

	// // json-ld
	// let f_json_ld = () => {
	// 	sparql_query('application/ld+json', `describe ${sv1_entity}`, (e_query, d_sparql_res, s_res_body) => {
	// 		// response mime type
	// 		d_res.type('application/');

	// 		// response status code
	// 		d_res.statusCode = e_query? 500: d_sparql_res.statusCode;

	// 		// head only; don't send body
	// 		if(b_head_only) return d_res.end();

	// 		// otherwise; send body
	// 		jsonld.toRDF(JSON.parse(s_res_body), {format:'application/nquads'}, (e_parse, s_nquads) => {
	// 			d_res.send(s_nquads);
	// 		});
	// 	});
	// };

	// content negotiation
	d_req.negotiate({
		'application/rdf+xml': f_rdf_xml,

		'text/turtle': () => {
			sparql_query('text/turtle', `describe ${sv1_entity}`, (e_query, d_sparql_res, s_res_body) => {
				// response mime type
				d_res.type('text/turtle');

				// response status code
				d_res.statusCode = e_query? 500: d_sparql_res.statusCode;

				// head only; don't send body
				if(b_head_only) return d_res.end();

				// otherwise; send body
				d_res.send(s_res_body);
			});
		},

		// 'application/ld+json': f_json_ld,
		// 'application/json': f_json_ld,

		'application/n-triples': () => {
			sparql_query('application/n-triples', `describe ${sv1_entity}`, (e_query, d_sparql_res, s_res_body) => {
				// response mime type
				d_res.type('application/n-triples');

				// response status code
				d_res.statusCode = e_query? 500: d_sparql_res.statusCode;

				// head only; don't send body
				if(b_head_only) return d_res.end();

				// otherwise; send body
				d_res.send(s_res_body);
			});
		},

		html: f_redirect,
		default: f_rdf_xml,
	});
};


// request for thing
k_app.use([
	//'/rdf/:group/:thing',
	'/lod/:group/:thing',
], negotiate_feature);


// handler for /lod/ontology, with content negotation
const serve_ontology_site = (d_req, d_res, f_next) => {
	d_req.negotiate({
		'text/html': () => {
			d_res.type("text/html");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_BASE_DIR, 'index.html'));
		},
		'application/rdf+xml': () => {
			d_res.type("application/rdf+xml");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_BASE_DIR, 'ontology.rdf'));
		},
		'text/turtle': () => {
			d_res.type("text/turtle");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_BASE_DIR, 'ontology.ttl'));
		},
		'application/ld+json': () => {
			d_res.type("application/ld+json");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_BASE_DIR, 'ontology.jsonld'));
		},
		'text/ntriples': () => {
			d_res.type("text/ntriples");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_BASE_DIR, 'ontology.nt'));
		}
	});
}

// handler for /lod/ontology with extension
const serve_ontology_file = (d_req, d_res, f_next) => {
	const extension = d_req.params.ext;
	const file_path = path.join(PD_ROOT, SCHEMA_BASE_DIR, 'ontology' + extension)

	if (!fs.existsSync(file_path)) {
		d_res.statusCode = 404;
		d_res.send("Not Found")

		return;
	}

	var content_type;

	if (extension == ".ttl") {
		content_type = "text/turtle";
	} if (extension == ".nt") {
		content_type = "text/ntriples";
	} if (extension == ".rdf") {
		content_type = "application/rdf+xml";
	} if (extension == ".jsonld") {
		content_type = "application/ld+json";
	}

	d_res.type(content_type);
	d_res.statusCode = 200;
	d_res.sendFile(file_path);
}


// handler for /lod/ontology, with content negotation
const serve_lite_ontology_site = (d_req, d_res, f_next) => {
	d_req.negotiate({
		'text/html': () => {
			d_res.type("text/html");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR, 'index.html'));
		},
		'application/rdf+xml': () => {
			d_res.type("application/rdf+xml");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR, 'ontology.rdf'));
		},
		'text/turtle': () => {
			d_res.type("text/turtle");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR, 'ontology.ttl'));
		},
		'application/ld+json': () => {
			d_res.type("application/ld+json");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR, 'ontology.jsonld'));
		},
		'text/ntriples': () => {
			d_res.type("text/ntriples");
			d_res.statusCode = 200;
			d_res.sendFile(path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR, 'ontology.nt'));
		}
	});
}

// handler for /lod/ontology with extension
const serve_lite_ontology_file = (d_req, d_res, f_next) => {
	const extension = d_req.params.ext;
	const file_path = path.join(PD_ROOT, SCHEMA_LITE_BASE_DIR, 'ontology' + extension)

	if (!fs.existsSync(file_path)) {
		d_res.statusCode = 404;
		d_res.send("Not Found")

		return;
	}

	var content_type;

	if (extension == ".ttl") {
		content_type = "text/turtle";
	} if (extension == ".nt") {
		content_type = "text/ntriples";
	} if (extension == ".rdf") {
		content_type = "application/rdf+xml";
	} if (extension == ".jsonld") {
		content_type = "application/ld+json";
	}

	d_res.type(content_type);
	d_res.statusCode = 200;
	d_res.sendFile(file_path);
}


// requests for /lod/ontology
k_app.use([
	'/lod/ontology',
], serve_ontology_site);

k_app.use([
	'/lod/ontology:ext',
], serve_ontology_file);


// requests for /lod/ontology
k_app.use([
	'/lod/lite-ontology',
], serve_lite_ontology_site);

k_app.use([
	'/lod/lite-ontology:ext',
], serve_lite_ontology_file);


// fetch specific pack
k_app.get([
	'/static/pack/:pack',
], (d_req, d_res) => {
	// extract pack
	let s_pack = d_req.params.pack;
	assert_safe_path(s_pack);

	d_res.sendFile(path.join(P_DIR_FETCH, 'packs', s_pack+'.json'));
});

// fetch specific pack
k_app.get([
	'/static/context/:context',
], (d_req, d_res) => {
	// extract context
	let s_context = d_req.params.context;
	assert_safe_path(s_context);
	debugger;
	d_res.header('Access-Control-Allow-Origin', '*');
	d_res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
	d_res.sendFile(path.join(P_DIR_FETCH, 'contexts', s_context+'.json'), {
		headers: {
			'Content-Type': 'application/ld+json',
		},
	});
});

// fetch specific config
k_app.get([
	/^\/static\/config\/(.+)$/,
], (d_req, d_res) => {
	// extract source
	let s_source = resolve_endpoint(d_req.params[0], d_res);
	if(!s_source) return;

	// send json response
	d_res.json(
		{
			// context: 'http://phuzzy.link/context/default',
			context: {
				'@context': {
					adlg: 'http://adl-gazetteer.geog.ucsb.edu/feature/',
					adlgont: 'http://adl-gazetteer.geog.ucsb.edu/ontology/',
					adlgeo: 'http://adl-gazetteer.geog.ucsb.edu/geometry/',
					ago: 'http://awesemantic-geo.link/ontology/',
					bif: 'http://www.openlinksw.com/schemas/bif#',
					'category-en': 'http://dbpedia.org/resource/Category:',
					'category-eo': 'http://eo.dbpedia.org/resource/Kategorio:',
					cegis: 'http://data.usgs.gov/lod/cegis/ontology/',
					cegisf: 'http://data.usgs.gov/lod/cegis/feature/',
					dawgt: 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#',
					dbr: 'http://dbpedia.org/resource/',
					'dbr-cs': 'http://cs.dbpedia.org/resource/',
					'dbr-de': 'http://de.dbpedia.org/resource/',
					'dbr-el': 'http://el.dbpedia.org/resource/',
					'dbr-eo': 'http://eo.dbpedia.org/resource/',
					'dbr-es': 'http://es.dbpedia.org/resource/',
					'dbr-eu': 'http://eu.dbpedia.org/resource/',
					'dbr-fr': 'http://fr.dbpedia.org/resource/',
					'dbr-id': 'http://id.dbpedia.org/resource/',
					'dbr-it': 'http://it.dbpedia.org/resource/',
					'dbr-ja': 'http://ja.dbpedia.org/resource/',
					'dbr-ko': 'http://ko.dbpedia.org/resource/',
					'dbr-nl': 'http://nl.dbpedia.org/resource/',
					'dbr-pl': 'http://pl.dbpedia.org/resource/',
					'dbr-pt': 'http://pt.dbpedia.org/resource/',
					'dbr-ru': 'http://ru.dbpedia.org/resource/',
					dbo: 'http://dbpedia.org/ontology/',
					dbp: 'http://dbpedia.org/property/',
					dc: 'http://purl.org/dc/elements/1.1/',
					dt: 'http://dbpedia.org/datatype/',
					dcterms: 'http://purl.org/dc/terms/',
					fn: 'http://www.w3.org/2005/xpath-functions/#',
					foaf: 'http://xmlns.com/foaf/0.1/',
					freebase: 'http://rdf.freebase.com/ns/',
					geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
					geonames: 'http://sws.geonames.org/',
					'geonames-o': 'http://www.geonames.org/ontology#',
					georss: 'http://www.georss.org/georss/',
					go: 'http://purl.org/obo/owl/GO#',
					gnis: 'http://data.usgs.gov/lod/gnis/ontology/',
					gnisf: 'http://data.usgs.gov/lod/gnis/feature/',
					ldp: 'http://www.w3.org/ns/ldp#',
					lgdg: 'http://linkedgeodata.org/geometry/',
					lgdm: 'http://linkedgeodata.org/meta/',
					lgdo: 'http://linkedgeodata.org/ontology/',
					lgdr: 'http://linkedgeodata.org/triplify/',
					math: 'http://www.w3.org/2000/10/swap/math#',
					mesh: 'http://purl.org/commons/record/mesh/',
					mf: 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#',
					nci: 'http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl#',
					ngeo: 'http://geovocab.org/geometry#',
					nyt: 'http://data.nytimes.com/',
					obo: 'http://www.geneontology.org/formats/oboInOwl#',
					ogc: 'http://www.opengis.net/',
					ogcgml: 'http://www.opengis.net/ont/gml#',
					ogcgsf: 'http://www.opengis.net/def/function/geosparql/',
					ogcgsr: 'http://www.opengis.net/def/rule/geosparql/',
					ogcsf: 'http://www.opengis.net/ont/sf#',
					opencyc: 'http://sw.opencyc.org/2008/06/10/concept/',
					owl: 'http://www.w3.org/2002/07/owl#',
					product: 'http://www.buy.com/rss/module/productV2/',
					'prop-eo': 'http://eo.dbpedia.org/property/',
					protseq: 'http://purl.org/science/protein/bysequence/',
					prov: 'http://www.w3.org/ns/prov#',
					rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
					rdfa: 'http://www.w3.org/ns/rdfa#',
					rdfdf: 'http://www.openlinksw.com/virtrdf-data-formats#',
					rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
					sc: 'http://purl.org/science/owl/sciencecommons/',
					schema: 'http://schema.org/',
					scovo: 'http://purl.org/NET/scovo#',
					sd: 'http://www.w3.org/ns/sparql-service-description#',
					sioc: 'http://rdfs.org/sioc/ns#',
					skos: 'http://www.w3.org/2004/02/skos/core#',
					spatial: 'http://geovocab.org/spatial#',
					sql: 'sql:',
					'template-en': 'http://dbpedia.org/resource/Template:',
					'template-eo': 'http://eo.dbpedia.org/resource/Template:',
					'umbel-ac': 'http://umbel.org/umbel/ac/',
					'umbel-rc': 'http://umbel.org/umbel/rc/',
					'umbel-sc': 'http://umbel.org/umbel/sc/',
					'usgeo-point': 'http://data.usgs.gov/lod/geometry/point/',
					'usgeo-polyline': 'http://data.usgs.gov/lod/geometry/polyline/',
					'usgeo-polygon': 'http://data.usgs.gov/lod/geometry/polygon/',
					'usgeo-multipoint': 'http://data.usgs.gov/lod/geometry/multipoint/',
					'usgeo-multipolyline': 'http://data.usgs.gov/lod/geometry/multipolyline/',
					'usgeo-multipolygon': 'http://data.usgs.gov/lod/geometry/multpolygon/',
					units: 'http://dbpedia.org/units/',
					vcard: 'http://www.w3.org/2001/vcard-rdf/3.0#',
					vcard2006: 'http://www.w3.org/2006/vcard/ns#',
					virtcxml: 'http://www.openlinksw.com/schemas/virtcxml#',
					virtrdf: 'http://www.openlinksw.com/schemas/virtrdf#',
					void: 'http://rdfs.org/ns/void#',
					vrank: 'http://purl.org/voc/vrank#',
					wd: 'http://www.wikidata.org/entity/',
					wdrs: 'http://www.w3.org/2007/05/powder-s#',
					'wiki-en': 'http://en.wikipedia.org/wiki/',
					'wiki-eo': 'http://eo.wikipedia.org/wiki/',
					wikicompany: 'http://dbpedia.openlinksw.com/wikicompany/',
					xf: 'http://www.w3.org/2004/07/xpath-functions',
					xml: 'http://www.w3.org/XML/1998/namespace',
					xsd: 'http://www.w3.org/2001/XMLSchema#',
					xsl10: 'http://www.w3.org/XSL/Transform/1.0',
					xsl1999: 'http://www.w3.org/1999/XSL/Transform',
					xslwd: 'http://www.w3.org/TR/WD-xsl',
					yago: 'http://dbpedia.org/class/yago/',
					'yago-res': 'http://mpii.de/yago/resource/',
					bibo: 'http://purl.org/ontology/bibo/',
					
					//kwgr: 'http://stko-roy.geog.ucsb.edu/lod/resource/',
					//'kwg-ont':'http://stko-roy.geog.ucsb.edu/lod/ontology/',
					kwgr: 'http://stko-kwg.geog.ucsb.edu/lod/resource/',
					'kwg-ont':'http://stko-kwg.geog.ucsb.edu/lod/ontology/',
					'kwgl-ont':'http://stko-kwg.geog.ucsb.edu/lod/lite-ontology/',
					'kwglr': 'http://stko-kwg.geog.ucsb.edu/lod/lite-resource/',
					sosa: 'http://www.w3.org/ns/sosa/',
					time: 'http://www.w3.org/2006/time#',

					//directrelief: 'https://stko-directrelief.geog.ucsb.edu/lod/ontology/' ,
					//'dr-affiliation': 'https://stko-directrelief.geog.ucsb.edu/lod/affiliation/' ,
    				//'dr-people': 'https://stko-directrelief.geog.ucsb.edu/lod/people/' ,
					//'dr-expertise': 'https://stko-directrelief.geog.ucsb.edu/lod/expertise/' ,
					//'dr-place': 'https://stko-directrelief.geog.ucsb.edu/lod/place/' ,

					 iospress: 'http://ld.iospress.nl/rdf/ontology/',
					 'iospress-category': 'http://ld.iospress.nl/rdf/category/',
					 'iospress-datatype': 'http://ld.iospress.nl/rdf/datatype/',
					 'iospress-index': 'http://ld.iospress.nl/rdf/index/',
					 'iospress-alias': 'http://ld.iospress.nl/rdf/alias/',
					 'iospress-artifact': 'http://ld.iospress.nl/rdf/artifact/',
					 'iospress-contributor': 'http://ld.iospress.nl/rdf/contributor/',
					 'iospress-organization': 'http://ld.iospress.nl/rdf/organization/',
					 'iospress-geocode': 'http://ld.iospress.nl/rdf/geocode/',
					geo: 'http://www.opengis.net/ont/geosparql#',
				},
			},
			order: [
				'rdf:*',
				'rdfs:*',
				'geo:*',
				'time:*',
				'kwg-ont:hasSegment',
				'kwg-ont:consectivePlace',
				'sosa:isFeatureOfInterest',
				'kwg-ont:firstName',
				'kwg-ont:lastName',
				'kwg-ont:fullName',
				'kwg-ont:affiliation',
				'kwg-ont:department',
				'kwg-ont:hasExpertise',
				'kwg-ont:personalPage',
				'kwg-ont:*',
				'sosa:*',
				//'dr:firstName',
				//'dr:lastName',
				//'dr:fullName',
				//'dr:affiliation',
				//'dr:department',
				//'dr:hasExpertise',
				//'dr:personalPage',

				 'iospress:category',
				 'iospress:organizationName',
				 'iospress:organizationInstitution',
				 'iospress:organizationPlace',
				 'iospress:organizationCountry',
				 'iospress-geocode:city',
				 'iospress-geocode:zone',
				 'iospress-geocode:region',
				 'iospress-geocode:postalCode',
				 'iospress-geocode:country',
				 'iospress:name',
				 'iospress:journalName',
				 'iospress:publisherName',
				 'iospress:publicationTitle',
				 'iospress:contributorFullName',
				'iospress:contributorFirstName',
				'iospress:contributorLastName',
				'iospress:id',
				'iospress:journalId',
				'iospress:publicationId',
				'iospress:issn',
				'iospress:journalIssn',
				'iospress:pIssn',
				'iospress:journalPIssn',
				'iospress:eIssn',
				'iospress:journalEIssn',
				'iospress:journalPublisher',
				'iospress:publisher',
				'iospress:publicationAbstract',
				'iospress:publicationDoi',
				'iospress:publicationDoiUrl',
				'iospress:publicationAuthorList',
				'iospress:publicationEditorList',
				'iospress:publicationReceivedDate',
				'iospress:publicationAcceptedDate',
				'iospress:publicationDate',
				'iospress:publicationPreprintDate',
				'iospress:publicationPageStart',
				'iospress:publicationPageEnd',
				'iospress:contributorRole',
				'iospress:contributorAffiliation',
				'iospress:volumeInJournal',
				'iospress:bookInSeries',
				'iospress:issueInVolume',
				'iospress:chapterInBook',
				'iospress:articleInIssue',
				'iospress:partOf',
				'iospress:issueNumber',
				'iospress:issueDate',
				'iospress:volumeNumber',
				'iospress:volumeReflectsYear',
				'ago:geometry',
				'iospress:*',
				'bibo:*',
				'dcterms:*',
				'owl:sameAs',
			],
			settings: {
				language: 'en',
				locale: 'en-US',
				limit: 256,
			},
			plugins: [
				{
					name: 'phuzzy-xsd',
				},
				{
					name: 'phuzzy-language-filter',
				}, {
					name: 'phuzzy-colored-prefixes',
					args: {
						palettes: 6,
					},
				},
				// {
				// 	name: 'phuzzy-info',
				// 	args: {
				// 		predicates: [
				// 			'http://purl.org/ontology/bibo/abstract',
				// 		],
				// 	},
				// },
				// {
				// 	name: 'phuzzy-geo',
				// 	args: {},
				// },
			],
		},
	).end();
});

// describe plugin
k_app.get([
	'/static/plugin/:plugin',
], (d_req, d_res) => {
	// fetch plugin name
	let s_plugin = d_req.params.plugin;

	// content negotiation
	d_req.negotiate({
		'text/html': () => {
			// use npm to install package locally
			check_npm_package(s_plugin, (e_check, s_semver) => {
				if(e_check) {
					d_res.status(500).end('failed to check for plugin');
				}
				else {
					d_res.end(`${s_plugin} is ${s_semver? 'already': 'not yet'} installed`);
				}
			});
		},

		// json
		'application/json': () => {
			fetch_package(s_plugin, d_res, (h_package) => {
				d_res.json(h_package.assets || {}).end();
			});
		},

		// javascript
		'text/javascript': () => {
			fetch_package(s_plugin, d_res, (h_package) => {
				// set main entry as asset
				let p_asset = h_package.main.replace(/^(\/*|(\.+\/)*)*/, '');

				// redirect
				d_res.redirect(303, `/static/plugin/${s_plugin}/${p_asset}`);
			});
		},
	});
});


class streamStringWrapper extends stream.Transform {
	constructor(s_head, s_tail) {
		super();

		// flag for marking first chunk
		this.began = false;

		// head and tail
		this.head = Buffer.from(s_head+' ');
		this.tail = Buffer.from(' '+s_tail);
	}

	_transform(ab_chunk, s_encoding, fk_chunk) {
		// just started
		if(!this.began) {
			// concat head + chunk
			fk_chunk(null, Buffer.concat([this.head, ab_chunk], this.head.length+ab_chunk.length));

			// set flag
			this.began = true;
		}
		// continuation
		else {
			fk_chunk(null, ab_chunk);
		}
	}

	_flush(fk_flush) {
		// push tail
		this.push(this.tail);

		// eof
		this.push(null);

		// done
		fk_flush();
	}
}

// describe plugin
k_app.get([
	/^\/static\/plugin\/([\w0-9_-]+)\/([^/].*)/,
], (d_req, d_res) => {
	// fetch plugin name
	let s_plugin = d_req.params[0];

	// fetch asset path
	let p_asset = d_req.params[1];

	// bad path
	if(p_asset.includes('..')) {
		d_req.status(400).end('asset may not contain two consecutive full stops ');
	}

	// use npm to install package locally
	install_npm_package(s_plugin, (e_install, s_data) => {
		// install error
		if(e_install) {
			d_res.status(400).end('failed to install plugin '+e_install);
		}
		// package is ready
		else {
			// set its directory
			let p_dir_plugin = path.join(P_DIR_PLUGINS, 'node_modules', s_plugin);

			// full path to asset file
			let p_asset_file = path.join(p_dir_plugin, p_asset);

			// asset is a js file
			if(p_asset.endsWith('.js')) {
				// path for cached bundled version
				let p_bundle_cached = path.join(P_DIR_PLUGINS, 'cache', s_plugin+'.js');

				// try reading
				fs.open(p_bundle_cached, 'r', (e_open, df_cached) => {
					// i/o error, file not exists?
					if(e_open) {
						// new bundle
						let k_bundle = browserify({
							standalone: 'phuzzy-xsd',
						});

						// uglify
						require('uglifyify');
						k_bundle.transform('uglifyify', {global:true});

						try {
							// add asset
							k_bundle.add(p_asset_file);

							// bundle
							let ds_bundle = k_bundle.bundle()
								// add head and tail
								.pipe(new streamStringWrapper('var module = {exports: {}};', 'module;'));

							// save to file
							ds_bundle.pipe(fs.createWriteStream(p_bundle_cached));

							// pipe to response
							ds_bundle.pipe(d_res);
						}
						catch(e_bundle) {
							// invalid module path
							if(e_bundle.message.startsWith('Cannot find module')) {
								d_res.status(400).end(`npm package does not contain a module "${p_asset}"`);
							}
							// failed to bundle
							else {
								d_res.status(500).end('failed to bundle:: '+e_bundle);
							}
						}
					}
					// i/o okay
					else {
						// create read stream and pipe to response
						fs.createReadStream(p_bundle_cached, {
							fd: df_cached,
						}).pipe(d_res);
					}
				});
			}
			// asset is something else
			else {
				d_res.sendFile(p_asset_file);
			}
		}
	});
});


// before server starts
async.parallel([
	(fk_task) => {
		// handle i/o now
		mkdirp(path.join(P_DIR_PLUGINS, 'cache'), (e_mkdirp) => {
			// i/o error
			if(e_mkdirp) {
				return fk_task(e_mkdirp);
			}

			fk_task(null);
		});
	},
], (e_tasks) => {
	// startup errors
	if(e_tasks) {
		throw e_tasks;
	}

	const d_server = require('http').Server(k_app);

	// bind to port
	d_server.listen(N_PORT, () => {
		console.log('running on port '+N_PORT);
	});

	d_server.on('error', (e_server) => {
		console.error(e_server);
	});
});


process.on('uncaughtException', (e_uncaught) => {
	console.error(e_uncaught.stack);
});
