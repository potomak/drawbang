require 'spec/spec_helper'

describe "index.haml" do
  it "should display 'Gallery' title" do
    render("/views/index.haml", :params => {})
    rendered.should match(/Gallery/)
  end

  it "should include javascript to remove app requests" do
    render("/views/index.haml", :params => {:request_ids => "1,2,3"})
    rendered.should match(/FB\.api\('1/)
    rendered.should match(/FB\.api\('2/)
    rendered.should match(/FB\.api\('3/)
  end
end