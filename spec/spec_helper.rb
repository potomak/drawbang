require 'server'

require 'rack/test'
require 'rspec'

# set test environment
set :environment, :test
set :run, false
set :raise_errors, true
set :logging, false

# omniauth test configuration
# see https://github.com/intridea/omniauth/wiki/Integration-Testing
OmniAuth.config.test_mode = true

# setup views specs
# see http://japhr.blogspot.com/2009/03/rspec-with-sinatra-haml.html

# Renders the supplied template with Haml::Engine and assigns the
# @rendered instance variable
def render(template, stubs={})
  template = File.read(".#{template}")
  template_object = Object.new
  template_object.stub!({:content_for => nil, :haml => nil}.merge(stubs))
  engine = Haml::Engine.new(template)
  @rendered = engine.render(template_object, assigns_for_template)
end

# Convenience method to access the @rendered instance variable set in
# the render call
def rendered
  @rendered
end

# Sets the local variables that will be accessible in the HAML
# template
def assigns
  @assigns ||= {}
end

# Prepends the assigns keywords with an "@" so that they will be
# instance variables when the template is rendered.
def assigns_for_template
  assigns.inject({}) do |memo, kv|
    memo["@#{kv[0].to_s}".to_sym] = kv[1]
    memo
  end
end